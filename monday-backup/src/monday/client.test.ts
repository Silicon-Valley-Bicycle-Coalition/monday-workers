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

  it('yields boardItemPages page by page, following the cursor until it is null', async () => {
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
    const pages = [];
    for await (const page of client.boardItemPages('123')) pages.push(page);

    expect(pages).toEqual([
      [{ id: 'i1', name: 'Item 1', groupId: 'g1', columnValues: [{ id: 'c1', text: 'a', value: '"a"' }] }],
      [{ id: 'i2', name: 'Item 2', groupId: null, columnValues: [] }],
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
        ok({ errors: [{ message: 'Query has complexity of 10, which exceeds max complexity of 5', extensions: { code: 'ComplexityException' } }] }),
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
