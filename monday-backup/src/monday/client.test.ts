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
    expect(boards[0]).toMatchObject({ id: '0', name: 'Board 0', workspaceId: 'ws-1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(secondBody.variables.page).toBe(2);
  });

  // Issue #30: archived boards and the board metadata needed to recreate a board.
  it('lists boards in every state, with the metadata a restore needs', async () => {
    const fetchMock = mockFetchSequence([
      {
        data: {
          boards: [
            {
              id: '1',
              name: 'Donations',
              workspace_id: 'ws-1',
              state: 'archived',
              type: 'board',
              board_kind: 'private',
              description: 'All gifts',
              board_folder_id: 'f-9',
              permissions: 'everyone',
              item_terminology: 'donation',
              updated_at: '2026-08-01T00:00:00Z',
            },
          ],
        },
      },
    ]);
    const boards = await new HttpMondayClient('https://api.monday.com/v2', 'token-123').listBoards();
    expect(boards).toEqual([
      {
        id: '1',
        name: 'Donations',
        workspaceId: 'ws-1',
        state: 'archived',
        type: 'board',
        boardKind: 'private',
        description: 'All gifts',
        folderId: 'f-9',
        permissions: 'everyone',
        itemTerminology: 'donation',
        updatedAt: '2026-08-01T00:00:00Z',
      },
    ]);
    const query = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).query as string;
    expect(query).toMatch(/boards\(limit: \$limit, page: \$page, state: all\)/);
  });

  it('fetches board schema, including column descriptions and group colour/position', async () => {
    mockFetchSequence([
      {
        data: {
          boards: [
            {
              columns: [{ id: 'c1', title: 'Status', type: 'status', settings_str: '{}', description: 'Stage' }],
              groups: [{ id: 'g1', title: 'Group 1', color: '#037f4c', position: '65536' }],
            },
          ],
        },
      },
    ]);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    const schema = await client.getBoardSchema('123');
    expect(schema.columns).toEqual([{ id: 'c1', title: 'Status', type: 'status', settingsStr: '{}', description: 'Stage' }]);
    expect(schema.groups).toEqual([{ id: 'g1', title: 'Group 1', color: '#037f4c', position: '65536' }]);
  });

  it('throws when a board is not found for schema lookup', async () => {
    mockFetchSequence([{ data: { boards: [] } }]);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await expect(client.getBoardSchema('123')).rejects.toThrow(/board 123 not found/);
  });

  it('yields boardItemPages page by page: items_page first, then next_items_page until the cursor is null', async () => {
    const rawItem = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: `Item ${id}`,
      state: 'active',
      created_at: '2026-01-02T03:04:05Z',
      updated_at: '2026-02-03T04:05:06Z',
      creator_id: '77',
      group: { id: 'g1' },
      parent_item: null,
      column_values: [],
      assets: [],
      ...extra,
    });
    const fetchMock = mockFetchSequence([
      { data: { boards: [{ items_page: { cursor: 'next-cursor', items: [rawItem('i1')] } }] } },
      { data: { next_items_page: { cursor: null, items: [rawItem('i2', { group: null, parent_item: { id: 'i1' } })] } } },
    ]);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    const pages = [];
    for await (const page of client.boardItemPages('123')) pages.push(page);

    const common = {
      state: 'active',
      createdAt: '2026-01-02T03:04:05Z',
      updatedAt: '2026-02-03T04:05:06Z',
      creatorId: '77',
      columnValues: [],
      assets: [],
    };
    expect(pages).toEqual([
      [{ id: 'i1', name: 'Item i1', groupId: 'g1', parentItemId: null, ...common }],
      [{ id: 'i2', name: 'Item i2', groupId: null, parentItemId: 'i1', ...common }],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(second.query).toContain('next_items_page(cursor: $cursor');
    expect(second.variables.cursor).toBe('next-cursor');
  });

  // Issue #30: connect-boards/mirror columns return text: null on current API versions.
  it('captures linked item ids and display values for connect, dependency and mirror columns, plus asset metadata', async () => {
    const fetchMock = mockFetchSequence([
      {
        data: {
          boards: [
            {
              items_page: {
                cursor: null,
                items: [
                  {
                    id: 'i1',
                    name: 'Gift',
                    state: 'active',
                    created_at: null,
                    updated_at: null,
                    creator_id: null,
                    group: { id: 'g1' },
                    parent_item: null,
                    column_values: [
                      { id: 'donor', type: 'board_relation', text: null, value: null, linked_item_ids: ['501', 502], display_value: 'Ada, Grace' },
                      { id: 'donor_email', type: 'mirror', text: null, value: null, display_value: 'ada@example.org' },
                      { id: 'status', type: 'status', text: 'Received', value: '{"index":1}' },
                    ],
                    assets: [
                      {
                        id: 'a1',
                        name: 'receipt.pdf',
                        file_extension: '.pdf',
                        file_size: 1234,
                        created_at: '2026-03-01T00:00:00Z',
                        url: 'https://svbc.monday.com/protected_static/1/resources/a1/receipt.pdf',
                        uploaded_by: { id: '77' },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    const pages = [];
    for await (const page of new HttpMondayClient('https://api.monday.com/v2', 'token-123').boardItemPages('1')) pages.push(page);
    const item = pages[0]![0]!;
    expect(item.columnValues).toEqual([
      { id: 'donor', type: 'board_relation', text: null, value: null, linkedItemIds: ['501', '502'], displayValue: 'Ada, Grace' },
      { id: 'donor_email', type: 'mirror', text: null, value: null, displayValue: 'ada@example.org' },
      { id: 'status', type: 'status', text: 'Received', value: '{"index":1}' },
    ]);
    expect(item.assets).toEqual([
      {
        id: 'a1',
        name: 'receipt.pdf',
        fileExtension: '.pdf',
        fileSize: 1234,
        createdAt: '2026-03-01T00:00:00Z',
        url: 'https://svbc.monday.com/protected_static/1/resources/a1/receipt.pdf',
        uploadedById: '77',
      },
    ]);
    const query = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).query as string;
    expect(query).toContain('... on BoardRelationValue { linked_item_ids display_value }');
    expect(query).toContain('... on MirrorValue { display_value }');
    expect(query).toContain('parent_item { id }');
  });

  // Issue #30: updates (comments) and their replies were not captured at all.
  it('pages a board’s updates, with replies and asset metadata, until a short page', async () => {
    const rawUpdate = (id: string) => ({
      id,
      item_id: 'i1',
      body: `<p>Update ${id}</p>`,
      text_body: `Update ${id}`,
      created_at: '2026-04-01T10:00:00Z',
      updated_at: '2026-04-01T10:00:00Z',
      creator_id: '77',
      replies: [{ id: `r${id}`, body: '<p>Thanks</p>', text_body: 'Thanks', created_at: '2026-04-02T10:00:00Z', updated_at: null, creator_id: '78' }],
      assets: [],
    });
    const fullPage = Array.from({ length: 100 }, (_, i) => rawUpdate(`u${i}`));
    const fetchMock = mockFetchSequence([
      { data: { boards: [{ updates: fullPage }] } },
      { data: { boards: [{ updates: [rawUpdate('u100')] }] } },
    ]);
    const pages = [];
    for await (const page of new HttpMondayClient('https://api.monday.com/v2', 'token-123').boardUpdatePages('1')) pages.push(page);

    expect(pages.map((p) => p.length)).toEqual([100, 1]);
    expect(pages[1]![0]).toEqual({
      id: 'u100',
      itemId: 'i1',
      body: '<p>Update u100</p>',
      textBody: 'Update u100',
      createdAt: '2026-04-01T10:00:00Z',
      updatedAt: '2026-04-01T10:00:00Z',
      creatorId: '77',
      replies: [{ id: 'ru100', body: '<p>Thanks</p>', textBody: 'Thanks', createdAt: '2026-04-02T10:00:00Z', updatedAt: null, creatorId: '78' }],
      assets: [],
    });
    const second = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(second.variables).toMatchObject({ boardId: ['1'], limit: 100, page: 2 });
  });

  it('lists docs, stopping when docs is null', async () => {
    mockFetchSequence([{ data: { docs: null } }]);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    const docs = await client.listDocs();
    expect(docs).toEqual([]);
  });

  it('lists docs with the metadata a restore needs', async () => {
    mockFetchSequence([
      {
        data: {
          docs: [
            { id: 'd1', object_id: 'o1', name: 'Runbook', workspace_id: 'ws-1', url: 'https://x/docs/o1', doc_kind: 'private', doc_folder_id: 'f1', created_at: '2026-01-01T00:00:00Z' },
          ],
        },
      },
    ]);
    const docs = await new HttpMondayClient('https://api.monday.com/v2', 'token-123').listDocs();
    expect(docs).toEqual([
      { id: 'd1', objectId: 'o1', name: 'Runbook', workspaceId: 'ws-1', url: 'https://x/docs/o1', docKind: 'private', folderId: 'f1', createdAt: '2026-01-01T00:00:00Z' },
    ]);
  });

  // Issue #30: `blocks` defaults to 25 per page, so a single unpaginated query silently truncated
  // every long Doc. The maximum page size isn't documented, so a short page is not trusted as the
  // last one — paging stops only on an empty page (or a repeated one, if `page` were ignored).
  it('pages doc blocks until an empty page, keeping hierarchy and position', async () => {
    const block = (id: string, parent: string | null = null) => ({
      id,
      type: 'normal_text',
      content: `{"deltaFormat":[{"insert":"${id}"}]}`,
      parent_block_id: parent,
      position: 1,
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      created_by: { id: '77' },
    });
    const fetchMock = mockFetchSequence([
      { data: { docs: [{ blocks: [block('b1'), block('b2', 'b1')] }] } },
      { data: { docs: [{ blocks: [block('b3')] }] } },
      { data: { docs: [{ blocks: [] }] } },
    ]);
    const pages = [];
    for await (const page of new HttpMondayClient('https://api.monday.com/v2', 'token-123').docBlockPages('doc-1')) pages.push(page);
    expect(pages.flat().map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
    expect(pages[0]![1]).toEqual({
      id: 'b2',
      type: 'normal_text',
      content: '{"deltaFormat":[{"insert":"b2"}]}',
      parentBlockId: 'b1',
      position: 1,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
      createdById: '77',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const pageArgs = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).variables.page);
    expect(pageArgs).toEqual([1, 2, 3]);
  });

  it('stops paging doc blocks if the API returns the same page again', async () => {
    const same = { data: { docs: [{ blocks: [{ id: 'b1', type: 'normal_text', content: null, parent_block_id: null, position: 1 }] }] } };
    const fetchMock = mockFetchSequence([same, same]);
    const pages = [];
    for await (const page of new HttpMondayClient('https://api.monday.com/v2', 'token-123').docBlockPages('doc-1')) pages.push(page);
    expect(pages.flat().map((b) => b.id)).toEqual(['b1']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when the doc is not found', async () => {
    mockFetchSequence([{ data: { docs: [] } }]);
    const iterate = async () => {
      for await (const _ of new HttpMondayClient('https://api.monday.com/v2', 'token-123').docBlockPages('doc-9')) {
        // drain
      }
    };
    await expect(iterate()).rejects.toThrow(/doc doc-9 not found/);
  });

  it('throws on GraphQL errors', async () => {
    mockFetchSequence([{ errors: [{ message: 'nope' }] }]);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await expect(client.listBoards()).rejects.toThrow(/nope/);
  });

  it('throws on a non-retryable HTTP response without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized', headers: new Headers() });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123', { sleepFn: async () => {} });
    await expect(client.listBoards()).rejects.toThrow(/HTTP 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('HttpMondayClient retry/backoff (issue #29)', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
  const httpStatus = (status: number, headers: Record<string, string> = {}) => ({
    ok: false,
    status,
    headers: new Headers(headers),
    text: async () => `status ${status}`,
    json: async () => ({}),
  });

  function client(fetchResponses: unknown[], sleeps: number[] = []) {
    const fetchMock = vi.fn();
    for (const r of fetchResponses) {
      if (r instanceof Error) fetchMock.mockRejectedValueOnce(r);
      else fetchMock.mockResolvedValueOnce(r);
    }
    vi.stubGlobal('fetch', fetchMock);
    const c = new HttpMondayClient('https://api.monday.com/v2', 'token-123', {
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      maxAttempts: 4,
    });
    return { c, fetchMock };
  }

  it('retries HTTP 429, honouring Retry-After', async () => {
    const sleeps: number[] = [];
    const { c, fetchMock } = client([httpStatus(429, { 'Retry-After': '7' }), ok({ data: { boards: [] } })], sleeps);
    await expect(c.listBoards()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toContain(7000);
  });

  it('retries 5xx and network errors', async () => {
    const { c, fetchMock } = client([httpStatus(502), new TypeError('network down'), ok({ data: { boards: [] } })]);
    await expect(c.listBoards()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries complexity-budget errors, waiting retry_in_seconds', async () => {
    const sleeps: number[] = [];
    const { c } = client(
      [
        ok({ errors: [{ message: 'Complexity budget exhausted', extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED', retry_in_seconds: 23 } }] }),
        ok({ errors: [{ message: 'Complexity budget exhausted, query cost 30001 budget remaining 18961 out of 1000000 reset in 32 seconds', extensions: { code: 'ComplexityException' } }] }),
        ok({ data: { boards: [] } }),
      ],
      sleeps,
    );
    await expect(c.listBoards()).resolves.toEqual([]);
    expect(sleeps).toContain(23000);
  });

  it('retries the HTTP-200 no-data rate-limit shape', async () => {
    const { c, fetchMock } = client([ok({ error_message: 'Rate Limit Exceeded', status_code: 429 }), ok({ data: { boards: [] } })]);
    await expect(c.listBoards()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a query that exceeds the per-query complexity cap (it can never succeed)', async () => {
    const { c, fetchMock } = client([
      ok({ errors: [{ message: 'Query has complexity of 6000000, which exceeds max complexity of 5000000', extensions: { code: 'ComplexityException' } }] }),
    ]);
    await expect(c.listBoards()).rejects.toThrow(/exceeds max complexity/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry an ordinary GraphQL error', async () => {
    const { c, fetchMock } = client([ok({ errors: [{ message: 'Field x does not exist' }] })]);
    await expect(c.listBoards()).rejects.toThrow(/does not exist/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts with the last error in the message', async () => {
    const { c, fetchMock } = client([httpStatus(503), httpStatus(503), httpStatus(503), httpStatus(503)]);
    await expect(c.listBoards()).rejects.toThrow(/exhausted 4 attempts.*HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('sends the bare token as Authorization', async () => {
    const fetchMock = mockFetchSequence([{ data: { boards: [] } }]);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token-123');
    await client.listBoards();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('token-123');
  });

  // Issue #30: 2026-01 is outside Monday's supported window (current 2026-07, maintenance 2026-04,
  // RC 2026-10); a deprecated version is silently served as the maintenance version. Pin current.
  it('pins API-Version 2026-07', async () => {
    const fetchMock = mockFetchSequence([{ data: { boards: [] } }]);
    await new HttpMondayClient('https://api.monday.com/v2', 'token-123').listBoards();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['API-Version']).toBe('2026-07');
  });
});
