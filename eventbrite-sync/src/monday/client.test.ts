import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpMondayClient, statusText } from './client';
import { mondayItem } from '../test/mondayItem';
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
  it('creates and changes with create_labels_if_missing only when asked', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ data: { create_item: { id: '1' }, change_multiple_column_values: { id: '1' } } }) }));
    vi.stubGlobal('fetch', fetchMock);
    const client = newClient();
    const sent = (n: number) => JSON.parse(fetchMock.mock.calls[n]![1].body as string);

    await client.createItem(1, 'x', {}, { createLabelsIfMissing: true });
    expect(sent(0).query).toContain('create_labels_if_missing: true');
    await client.changeColumnValues(1, '2', {}, { createLabelsIfMissing: true });
    expect(sent(1).query).toContain('create_labels_if_missing: true');
    await client.createItem(1, 'x', {});
    expect(sent(2).query).not.toContain('create_labels_if_missing');
    await client.changeColumnValues(1, '2', {});
    expect(sent(3).query).not.toContain('create_labels_if_missing');
  });

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
  it('sends the transport\'s single pinned API-Version (#39)', async () => {
    const fetchMock = mockFetchOnce({ data: { items_page_by_column_values: { items: [] } } });
    await newClient().findItemByColumnValue(1, 'x', 'y');
    expect(fetchMock.mock.calls[0]![1].headers['API-Version']).toBe(MONDAY_API_VERSION);
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

  describe('getItems', () => {
    it('reads item names, column text and raw values', async () => {
      const fetchMock = mockFetchOnce({
        data: { items: [{ id: '1', name: 'Jane', state: 'active', column_values: [
          { id: 'status', text: 'Registered', value: '{"index":1}' },
          { id: 'blank', text: null, value: null },
          { id: 'default', text: 'Bike Commuting (online)', value: null },
        ] }] },
      });

      const items = await newClient().getItems(999, ['1'], ['status', 'blank', 'default']);

      expect(items).toEqual([{
        id: '1', name: 'Jane', state: 'active',
        columns: { status: 'Registered', blank: '', default: 'Bike Commuting (online)' },
        values: { status: '{"index":1}', blank: null, default: null },
      }]);
      const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
      // Without a limit items(ids:) returns at most 25 items (Monday's default page size).
      expect(body.query).toMatch(/items\(ids: \$ids, limit: 100\)/);
      expect(body.query).toMatch(/\bstate\b/);
      expect(body.query).toMatch(/column_values\(ids: \$columnIds\) \{\s+id\s+text\s+value\s+\.\.\. on BoardRelationValue \{ linked_item_ids \}\s+\}/);
      expect(body.variables).toEqual({ ids: ['1'], columnIds: ['status', 'blank', 'default'] });
    });

    it('reads a board relation cell as its linked item ids, since Monday gives it no text or value', async () => {
      mockFetchOnce({
        data: { items: [{ id: '1', name: 'Jane', state: 'active', column_values: [
          { id: 'linked', text: null, value: null, linked_item_ids: ['5550001'], display_value: 'Pat Example' },
          { id: 'two', text: null, value: null, linked_item_ids: ['5', '6'] },
          { id: 'unlinked', text: null, value: null, linked_item_ids: [] },
          { id: 'plain', text: 'x', value: null },
        ] }] },
      });

      const [item] = await newClient().getItems(999, ['1'], ['linked', 'two', 'unlinked', 'plain']);

      expect(item!.columns).toEqual({ linked: '5550001', two: '5,6', unlinked: '', plain: 'x' });
      expect(item!.values.linked).toBeNull();
    });

    it('passes archived and deleted items through with their state', async () => {
      mockFetchOnce({
        data: { items: [
          { id: '1', name: 'A', state: 'archived', column_values: [] },
          { id: '2', name: 'B', state: 'deleted', column_values: [] },
        ] },
      });

      const items = await newClient().getItems(999, ['1', '2'], []);

      expect(items.map((i) => i.state)).toEqual(['archived', 'deleted']);
    });

    it('batches 230 ids into 3 requests and returns nothing for no ids', async () => {
      const fetchMock = mockFetchOnce({ data: { items: [] } });
      const ids = Array.from({ length: 230 }, (_, i) => String(i + 1));

      await newClient().getItems(999, ids, ['status']);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const sizes = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string).variables.ids.length);
      expect(sizes).toEqual([100, 100, 30]);

      fetchMock.mockClear();
      expect(await newClient().getItems(999, [], ['status'])).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('postUpdate', () => {
    it('postUpdate sends create_update once', async () => {
      const fetchMock = mockFetchOnce({ data: { create_update: { id: '9' } } });

      await newClient().postUpdate('777', 'Sent reminder to 3');

      const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
      expect(body.query).toContain('create_update');
      expect(body.variables).toEqual({ itemId: '777', body: 'Sent reminder to 3' });
    });

    it('is not retried after an ambiguous failure', async () => {
      const fetchMock = mockFetchOnce({}, false);
      await expect(newClient().postUpdate('777', 'x')).rejects.toBeInstanceOf(AmbiguousWriteError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

// Monday returns label id 5's text for an EMPTY status cell (value null), so a status reads as
// set only when its stored value carries a label index.
describe('statusText', () => {
  it('returns the trimmed label of a set status', () => {
    expect(statusText(mondayItem('1', 'A', { s: ' Attended ' }), 's')).toBe('Attended');
    expect(statusText(mondayItem('1', 'A', { s: 'Held' }, { values: { s: '{"index":0,"post_id":null}' } }), 's')).toBe('Held');
  });

  it('returns blank when the value is null or empty, even with label text', () => {
    expect(statusText(mondayItem('1', 'A', { s: 'Bike Commuting (online)' }, { values: { s: null } }), 's')).toBe('');
    expect(statusText(mondayItem('1', 'A', { s: 'Bike Commuting (online)' }, { values: { s: '' } }), 's')).toBe('');
  });

  it('returns blank when the stored value has no label index', () => {
    for (const v of ['{}', '{"index":null}', '{"index":"5"}', 'null', 'not json', '5']) {
      expect(statusText(mondayItem('1', 'A', { s: 'Learn to Ride' }, { values: { s: v } }), 's')).toBe('');
    }
  });

  it('returns blank for a column that was not read', () => {
    expect(statusText(mondayItem('1', 'A', {}), 's')).toBe('');
  });
});
