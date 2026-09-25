import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmbiguousWriteError, MondayGraphQL } from '../monday/graphql';
import { MondayRestoreApi } from './api';

function api(data: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ data }));
  vi.stubGlobal('fetch', fetchMock);
  const body = () => JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as { query: string; variables: Record<string, unknown> };
  return { restoreApi: new MondayRestoreApi(new MondayGraphQL('https://api.monday.com/v2', 't', { sleepFn: async () => {} })), body, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MondayRestoreApi', () => {
  it('creates an empty board in the target workspace', async () => {
    const { restoreApi, body } = api({ create_board: { id: '5' } });
    expect(await restoreApi.createBoard({ name: 'Donors (restored)', kind: 'private', workspaceId: '9', description: null })).toBe('5');
    expect(body().query).toContain('create_board(board_name: $name, board_kind: $kind, workspace_id: $workspaceId, description: $description, empty: true)');
    expect(body().variables).toEqual({ name: 'Donors (restored)', kind: 'private', workspaceId: '9', description: null });
  });

  it('sends column defaults and item values as JSON strings', async () => {
    const column = api({ create_column: { id: 'status' } });
    await column.restoreApi.createColumn({ boardId: '5', title: 'Stage', type: 'status', defaults: { labels: { '1': 'Active' } }, id: 'status' });
    expect(column.body().variables).toMatchObject({ type: 'status', defaults: '{"labels":{"1":"Active"}}', id: 'status' });
    expect(column.body().query).toContain('$type: ColumnType!');

    vi.unstubAllGlobals();
    const item = api({ create_item: { id: '7' } });
    await item.restoreApi.createItem({ boardId: '5', name: 'Ada', columnValues: { status: { label: 'Active' } } });
    expect(item.body().variables).toMatchObject({ values: '{"status":{"label":"Active"}}', groupId: null });
    expect(item.body().query).toContain('create_labels_if_missing: true');
  });

  it('posts a reply by parent_id only', async () => {
    const { restoreApi, body } = api({ create_update: { id: '8' } });
    await restoreApi.createUpdate({ itemId: '7', parentId: '6', body: '<p>hi</p>' });
    expect(body().variables).toEqual({ itemId: null, body: '<p>hi</p>', parentId: '6' });
  });

  it('creates a doc in a workspace location and blocks after a sibling', async () => {
    const doc = api({ create_doc: { id: '40' } });
    await doc.restoreApi.createDoc({ workspaceId: '9', name: 'Runbook', kind: 'private' });
    expect(doc.body().query).toContain('create_doc(location: { workspace: { workspace_id: $workspaceId, name: $name, kind: $kind } })');

    vi.unstubAllGlobals();
    const block = api({ create_doc_block: { id: 'b' } });
    await block.restoreApi.createDocBlock({ docId: '40', type: 'normal_text', content: '{}', afterBlockId: 'a' });
    expect(block.body().variables).toEqual({ docId: '40', type: 'normal_text', content: '{}', after: 'a', parent: null });
  });

  it('never retries a create that may have committed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    const restoreApi = new MondayRestoreApi(new MondayGraphQL('https://api.monday.com/v2', 't', { sleepFn: async () => {} }));
    await expect(restoreApi.createItem({ boardId: '5', name: 'Ada', columnValues: {} })).rejects.toBeInstanceOf(AmbiguousWriteError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
