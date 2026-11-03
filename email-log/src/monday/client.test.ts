import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpMondayClient } from './client';

function newClient() {
  return new HttpMondayClient('https://api.monday.com/v2', 'token-123', { sleepFn: async () => {} });
}

function mockFetchOnce(responseBody: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => responseBody });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const bodyOf = (fetchMock: ReturnType<typeof vi.fn>) => JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpMondayClient', () => {
  it('users(emails:) returns the id', async () => {
    const fetchMock = mockFetchOnce({ data: { users: [{ id: '777' }] } });
    expect(await newClient().findUserIdByEmail('staff@example.org')).toBe(777);
    const body = bodyOf(fetchMock);
    expect(body.query).toContain('users(emails:');
    expect(body.variables).toEqual({ email: 'staff@example.org' });
  });

  it('returns null when no user has the email', async () => {
    mockFetchOnce({ data: { users: [] } });
    expect(await newClient().findUserIdByEmail('nobody@example.org')).toBeNull();
  });

  it('items_page_by_column_values returns every id', async () => {
    const fetchMock = mockFetchOnce({ data: { items_page_by_column_values: { items: [{ id: '1' }, { id: '2' }] } } });
    expect(await newClient().findItemIdsByColumnValue(42, 'email_col', 'a@example.com')).toEqual(['1', '2']);
    const body = bodyOf(fetchMock);
    expect(body.query).toContain('limit: 100');
    expect(body.variables).toEqual({ boardId: 42, columns: [{ column_id: 'email_col', column_values: ['a@example.com'] }] });
  });

  it('returns the linked item ids of a board relation', async () => {
    const fetchMock = mockFetchOnce({ data: { items: [{ column_values: [{ linked_item_ids: ['9', '10'] }] }] } });
    expect(await newClient().getConnectedItemIds('5', 'aff_person_col')).toEqual(['9', '10']);
    expect(bodyOf(fetchMock).variables).toEqual({ itemId: '5', columnId: 'aff_person_col' });
  });

  it('returns no connected ids when the item or column is missing', async () => {
    mockFetchOnce({ data: { items: [] } });
    expect(await newClient().getConnectedItemIds('5', 'aff_person_col')).toEqual([]);
  });

  it('returns the board item count', async () => {
    mockFetchOnce({ data: { boards: [{ items_count: 321 }] } });
    expect(await newClient().boardItemsCount(111)).toBe(321);
  });

  it('throws when the board is not returned', async () => {
    mockFetchOnce({ data: { boards: [] } });
    await expect(newClient().boardItemsCount(111)).rejects.toThrow(/111/);
  });

  it('createItem is sent non-idempotent', async () => {
    // A 5xx on a non-idempotent write must not be retried in-process: exactly one fetch.
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(newClient().createItem(111, 'Email: hi', { a: 'b' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('createItem sends JSON-stringified column values and returns the id', async () => {
    const fetchMock = mockFetchOnce({ data: { create_item: { id: '456' } } });
    expect(await newClient().createItem(111, 'Email: hi', { a: 'b' })).toBe('456');
    const body = bodyOf(fetchMock);
    expect(body.variables.itemName).toBe('Email: hi');
    expect(JSON.parse(body.variables.columnValues)).toEqual({ a: 'b' });
  });
  it('createTimelineItem sends the entry non-idempotent and returns the id', async () => {
    const fetchMock = mockFetchOnce({ data: { create_timeline_item: { id: 'tl-1' } } });
    const input = { itemId: '11', customActivityId: 'act-1', title: 'Hi', summary: 'Hello', content: 'Hello<br>there', timestamp: '2026-10-19T17:05:09.000Z', url: 'https://example.monday.com/boards/1/pulses/2' };
    expect(await newClient().createTimelineItem(input)).toBe('tl-1');
    const body = bodyOf(fetchMock);
    expect(body.query).toContain('create_timeline_item(');
    expect(body.variables).toEqual(input);
  });

  it('createTimelineItem is not retried in-process on a 5xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      newClient().createTimelineItem({ itemId: '1', customActivityId: 'a', title: 't', summary: 's', content: 'c', timestamp: '2026-10-19T17:05:09.000Z', url: 'u' })
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
