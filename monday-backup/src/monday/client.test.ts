import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpMondayClient } from './client';

function mockFetchSequence(responses: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of responses) {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpMondayClient', () => {
  it('paginates listBoards until a short page is returned', async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      id: `${i}`,
      name: `Board ${i}`,
      workspace_id: 'ws-1',
    }));
    const shortPage = [{ id: '50', name: 'Board 50', workspace_id: 'ws-1' }];
    const fetchMock = mockFetchSequence([{ data: { boards: fullPage } }, { data: { boards: shortPage } }]);

    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    const boards = await client.listBoards();

    expect(boards).toHaveLength(51);
    expect(boards[0]).toEqual({ id: '0', name: 'Board 0', workspaceId: 'ws-1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(secondBody.variables.page).toBe(2);
  });

  it('fetches board schema', async () => {
    mockFetchSequence([
      {
        data: {
          boards: [
            {
              columns: [{ id: 'c1', title: 'Status', type: 'status', settings_str: '{}' }],
              groups: [{ id: 'g1', title: 'Group 1' }],
            },
          ],
        },
      },
    ]);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    const schema = await client.getBoardSchema('123');
    expect(schema.columns).toEqual([{ id: 'c1', title: 'Status', type: 'status', settingsStr: '{}' }]);
    expect(schema.groups).toEqual([{ id: 'g1', title: 'Group 1' }]);
  });

  it('throws when a board is not found for schema lookup', async () => {
    mockFetchSequence([{ data: { boards: [] } }]);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await expect(client.getBoardSchema('123')).rejects.toThrow(/board 123 not found/);
  });

  it('paginates getBoardItems by cursor until cursor is null', async () => {
    const fetchMock = mockFetchSequence([
      {
        data: {
          boards: [
            {
              items_page: {
                cursor: 'next-cursor',
                items: [{ id: 'i1', name: 'Item 1', group: { id: 'g1' }, column_values: [{ id: 'c1', text: 'a', value: '"a"' }] }],
              },
            },
          ],
        },
      },
      {
        data: {
          boards: [
            {
              items_page: {
                cursor: null,
                items: [{ id: 'i2', name: 'Item 2', group: null, column_values: [] }],
              },
            },
          ],
        },
      },
    ]);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    const items = await client.getBoardItems('123');

    expect(items).toEqual([
      { id: 'i1', name: 'Item 1', groupId: 'g1', columnValues: [{ id: 'c1', text: 'a', value: '"a"' }] },
      { id: 'i2', name: 'Item 2', groupId: null, columnValues: [] },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(secondBody.variables.cursor).toBe('next-cursor');
  });

  it('lists docs, stopping when docs is null', async () => {
    mockFetchSequence([{ data: { docs: null } }]);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    const docs = await client.listDocs();
    expect(docs).toEqual([]);
  });

  it('fetches doc blocks', async () => {
    mockFetchSequence([{ data: { docs: [{ blocks: [{ id: 'b1', type: 'normal_text', content: 'hi' }] }] } }]);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    const blocks = await client.getDocBlocks('doc-1');
    expect(blocks).toEqual([{ id: 'b1', type: 'normal_text', content: 'hi' }]);
  });

  it('throws on GraphQL errors', async () => {
    mockFetchSequence([{ errors: [{ message: 'nope' }] }]);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await expect(client.listBoards()).rejects.toThrow(/nope/);
  });

  it('throws on a non-OK HTTP response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await expect(client.listBoards()).rejects.toThrow(/HTTP 500/);
  });

  it('sends the bare token as Authorization', async () => {
    const fetchMock = mockFetchSequence([{ data: { boards: [] } }]);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await client.listBoards();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('token-123');
  });
});
