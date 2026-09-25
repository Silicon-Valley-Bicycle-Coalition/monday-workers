import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBackup, SNAPSHOT_FORMAT, type BackupDeps } from './backup';
import type { RunResult, SnapshotRunStore } from './db/runs';
import type { DriveClient } from './drive/client';
import type { MondayClient } from './monday/client';
import type { BackupConfig, BoardSummary, DocSummary, ItemRecord } from './types';

function fakeMonday(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    listBoards: async () => [],
    getBoardSchema: async () => ({ columns: [], groups: [] }),
    async *boardItemPages() {},
    listDocs: async () => [],
    getDocBlocks: async () => [],
    ...overrides,
  };
}

interface FakeFile {
  folderId: string;
  filename: string;
  mimeType: string;
  writes: string[];
  closed: boolean;
  aborted: boolean;
}

function fakeDrive(overrides: Partial<DriveClient> = {}) {
  const files: FakeFile[] = [];
  const drive: DriveClient = {
    ensureFolder: async () => 'folder-1',
    createFile: async (folderId, filename, mimeType) => {
      const file: FakeFile = { folderId, filename, mimeType, writes: [], closed: false, aborted: false };
      files.push(file);
      return {
        write: async (text) => {
          file.writes.push(text);
        },
        close: async () => {
          file.closed = true;
          return `id-${filename}`;
        },
        abort: async () => {
          file.aborted = true;
        },
      };
    },
    uploadJson: async (folderId, filename, data) => {
      files.push({ folderId, filename, mimeType: 'application/json', writes: [JSON.stringify(data)], closed: true, aborted: false });
    },
    ...overrides,
  };
  const completed = () => files.filter((f) => f.closed);
  return {
    drive,
    files,
    filenames: () => completed().map((f) => f.filename),
    records: (filename: string) =>
      files
        .find((f) => f.filename === filename)!
        .writes.join('')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    manifest: () => JSON.parse(files.find((f) => f.filename === 'manifest.json')!.writes.join('')) as Record<string, unknown>,
  };
}

function fakeRunStore(): SnapshotRunStore & { finishes: RunResult[]; failures: string[] } {
  const finishes: RunResult[] = [];
  const failures: string[] = [];
  return {
    recordRunStart: async () => 1,
    recordRunFinish: async (_runId, _finishedAtUtc, result) => {
      finishes.push(result);
    },
    recordRunFailure: async (_runId, _finishedAtUtc, errorMessage) => {
      failures.push(errorMessage);
      return failures.length;
    },
    finishes,
    failures,
  };
}

const config: BackupConfig = { destinationParentFolderId: 'parent-1', excludeBoardIds: [] };

function board(id: string, name = `Board ${id}`, workspaceId: string | null = 'ws-1'): BoardSummary {
  return { id, name, workspaceId };
}

function doc(id: string, name = `Doc ${id}`, workspaceId: string | null = 'ws-1'): DocSummary {
  return { id, name, workspaceId, url: null };
}

function item(id: string): ItemRecord {
  return { id, name: `Item ${id}`, groupId: null, columnValues: [] };
}

function deps(overrides: Partial<BackupDeps>): BackupDeps {
  return {
    monday: fakeMonday(),
    drive: fakeDrive().drive,
    runStore: fakeRunStore(),
    config,
    slackWebhookUrl: '',
    now: () => new Date('2026-08-25T09:00:00.000Z'),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runBackup', () => {
  it('streams every board and doc as JSONL plus a manifest, and records a success run', async () => {
    const monday = fakeMonday({
      listBoards: async () => [board('1'), board('2')],
      async *boardItemPages(boardId) {
        yield [item(`${boardId}-a`)];
      },
      listDocs: async () => [doc('d1')],
      getDocBlocks: async () => [{ id: 'b1', type: 'normal_text', content: '{}' }],
    });
    const fake = fakeDrive();
    const runStore = fakeRunStore();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    await runBackup(deps({ monday, drive: fake.drive, runStore, slackWebhookUrl: 'https://hooks.example/webhook' }));

    expect(fake.filenames()).toEqual(['board-1.jsonl', 'board-2.jsonl', 'doc-d1.jsonl', 'manifest.json']);
    expect(fake.files.every((f) => f.folderId === 'folder-1')).toBe(true);
    expect(fake.files.filter((f) => f.filename.endsWith('.jsonl')).every((f) => f.mimeType === 'application/x-ndjson')).toBe(true);

    expect(fake.records('board-1.jsonl')).toEqual([
      { type: 'board', board: board('1'), schema: { columns: [], groups: [] } },
      { type: 'item', item: item('1-a') },
    ]);
    expect(fake.records('doc-d1.jsonl')).toEqual([
      { type: 'doc', doc: doc('d1') },
      { type: 'block', block: { id: 'b1', type: 'normal_text', content: '{}' } },
    ]);

    const manifest = fake.manifest();
    expect(manifest).toMatchObject({
      format: SNAPSHOT_FORMAT,
      boardCount: 2,
      docCount: 1,
      itemCountsByBoard: { '1': 1, '2': 1 },
      blockCountsByDoc: { d1: 1 },
      errors: [],
    });

    expect(runStore.finishes).toEqual([{ status: 'success', boardCount: 2, docCount: 1, errorCount: 0, lastError: null }]);
    expect(fetchMock).not.toHaveBeenCalled(); // no partial-run alert sent
  });

  // Issue #29: a same-day rerun used to write a second set of same-named files into the same
  // dated folder. Each run now gets its own folder, named for the date and the D1 run id.
  it('writes each run into its own dated, run-numbered folder under the configured parent', async () => {
    const folders: [string, string][] = [];
    let nextRunId = 17;
    const runStore = { ...fakeRunStore(), recordRunStart: async () => nextRunId++ };
    const fake = fakeDrive({
      ensureFolder: async (parent, name) => {
        folders.push([parent, name]);
        return `folder-${name}`;
      },
    });
    await runBackup(deps({ drive: fake.drive, runStore }));
    await runBackup(deps({ drive: fake.drive, runStore, now: () => new Date('2026-08-25T15:30:00.000Z') }));
    expect(folders).toEqual([
      ['parent-1', '2026-08-25 run-17'],
      ['parent-1', '2026-08-25 run-18'],
    ]);
    const manifests = fake.files.filter((f) => f.filename === 'manifest.json');
    expect(manifests.map((m) => m.folderId)).toEqual(['folder-2026-08-25 run-17', 'folder-2026-08-25 run-18']);
    expect(JSON.parse(manifests[0]!.writes.join(''))).toMatchObject({ runId: 17, snapshotFolder: '2026-08-25 run-17' });
  });

  // Issue #29: cron invocations are killed at 15 minutes of wall time — like a CPU kill, that is
  // uncatchable. Stop starting new work at the budget so the manifest, D1 row and alert still land.
  it('stops at the wall-time budget, skipping remaining boards and docs, and reports a partial run', async () => {
    const start = Date.parse('2026-08-25T09:00:00.000Z');
    let t = start;
    const monday = fakeMonday({
      listBoards: async () => [board('1'), board('2'), board('3')],
      async *boardItemPages(boardId) {
        yield [item(`${boardId}-a`)];
        t += 4 * 60_000; // each board's page takes four minutes
        yield [item(`${boardId}-b`)];
      },
      listDocs: async () => [doc('d1')],
    });
    const fake = fakeDrive();
    const runStore = fakeRunStore();
    await runBackup(deps({ monday, drive: fake.drive, runStore, now: () => new Date(t), wallTimeBudgetMs: 10 * 60_000 }));

    // Boards 1 and 2 finish (t = 8 min); board 3 is started (under budget) but crosses it mid-page.
    expect(fake.filenames()).toEqual(['board-1.jsonl', 'board-2.jsonl', 'manifest.json']);
    expect(fake.files.find((f) => f.filename === 'board-3.jsonl')!.aborted).toBe(true);
    const errors = fake.manifest().errors as string[];
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/board 3 .*wall-time budget/);
    expect(errors[1]).toMatch(/doc d1 .*skipped.*wall-time budget/);
    expect(runStore.finishes[0]).toMatchObject({ status: 'partial', boardCount: 2, errorCount: 2 });
  });

  // Issue #30: archived boards are captured (listBoards asks for every state); boards already in
  // Monday's trash are not — their items can't be paged and trash is Monday's own 30-day undo.
  it('backs up archived boards, skips deleted ones, and lists the skipped ids in the manifest', async () => {
    const fake = fakeDrive();
    await runBackup(
      deps({
        monday: fakeMonday({
          listBoards: async () => [
            { ...board('1'), state: 'active' },
            { ...board('2'), state: 'archived' },
            { ...board('3'), state: 'deleted' },
          ],
        }),
        drive: fake.drive,
      }),
    );
    expect(fake.filenames()).toEqual(['board-1.jsonl', 'board-2.jsonl', 'manifest.json']);
    expect(fake.manifest().deletedBoardsSkipped).toEqual(['3']);
    expect(fake.manifest().errors).toEqual([]);
  });

  // Issue #30: subitems live on their own sub_items_board. Normally `boards` lists it, but the
  // parent's subtasks column names it too — back it up either way, exactly once.
  it("backs up a board's subitems board even when listBoards omits it, and only once", async () => {
    const subtasksColumn = { id: 'subitems', title: 'Subitems', type: 'subtasks', settingsStr: '{"boardIds":[99]}' };
    const fake = fakeDrive();
    await runBackup(
      deps({
        monday: fakeMonday({
          listBoards: async () => [board('1', 'Volunteers'), board('2', 'Events')],
          getBoardSchema: async (boardId) => ({
            columns: boardId === '1' || boardId === '2' ? [{ ...subtasksColumn, settingsStr: `{"boardIds":[${boardId === '1' ? 99 : 98}]}` }] : [],
            groups: [],
          }),
          async *boardItemPages(boardId) {
            if (boardId === '99') yield [{ ...item('s1'), parentItemId: 'p1' }];
          },
        }),
        drive: fake.drive,
        config: { destinationParentFolderId: 'parent-1', excludeBoardIds: ['98'] },
      }),
    );
    expect(fake.filenames()).toEqual(['board-1.jsonl', 'board-2.jsonl', 'board-99.jsonl', 'manifest.json']);
    const header = fake.records('board-99.jsonl')[0]!;
    expect(header.board).toMatchObject({ id: '99', type: 'sub_items_board', workspaceId: 'ws-1', parentBoardId: '1' });
    expect((fake.records('board-99.jsonl')[1]!.item as ItemRecord).parentItemId).toBe('p1');
  });

  it('writes a board one page at a time rather than buffering it whole', async () => {
    const monday = fakeMonday({
      listBoards: async () => [board('1')],
      async *boardItemPages() {
        yield [item('a'), item('b')];
        yield [item('c')];
        yield [item('d')];
      },
    });
    const fake = fakeDrive();
    await runBackup(deps({ monday, drive: fake.drive }));
    const file = fake.files.find((f) => f.filename === 'board-1.jsonl')!;
    expect(file.writes).toHaveLength(4); // header + one write per page
    expect(fake.records('board-1.jsonl').filter((r) => r.type === 'item').map((r) => (r.item as ItemRecord).id)).toEqual(['a', 'b', 'c', 'd']);
    expect(fake.manifest().itemCountsByBoard).toEqual({ '1': 4 });
  });

  it('cancels the upload of a board that fails mid-stream, so no partial file appears', async () => {
    const monday = fakeMonday({
      listBoards: async () => [board('1'), board('2')],
      async *boardItemPages(boardId) {
        yield [item('a')];
        if (boardId === '1') throw new Error('monday API: exhausted 5 attempts — last error: HTTP 503');
      },
    });
    const fake = fakeDrive();
    const runStore = fakeRunStore();
    await runBackup(deps({ monday, drive: fake.drive, runStore }));
    const failed = fake.files.find((f) => f.filename === 'board-1.jsonl')!;
    expect(failed).toMatchObject({ closed: false, aborted: true });
    expect(fake.filenames()).toEqual(['board-2.jsonl', 'manifest.json']);
    expect(runStore.finishes[0]).toMatchObject({ status: 'partial', boardCount: 1, errorCount: 1 });
  });

  it('skips boards listed in excludeBoardIds', async () => {
    const fake = fakeDrive();
    await runBackup(
      deps({
        monday: fakeMonday({ listBoards: async () => [board('1'), board('2')] }),
        drive: fake.drive,
        config: { destinationParentFolderId: 'parent-1', excludeBoardIds: ['2'] },
      }),
    );
    expect(fake.filenames()).toEqual(['board-1.jsonl', 'manifest.json']);
  });

  it('skips boards outside config.workspaceIds when set', async () => {
    const fake = fakeDrive();
    await runBackup(
      deps({
        monday: fakeMonday({ listBoards: async () => [board('1', 'Board 1', 'ws-1'), board('2', 'Board 2', 'ws-2')] }),
        drive: fake.drive,
        config: { destinationParentFolderId: 'parent-1', excludeBoardIds: [], workspaceIds: ['ws-1'] },
      }),
    );
    expect(fake.filenames()).toEqual(['board-1.jsonl', 'manifest.json']); // board 2 (ws-2) filtered out
  });

  it('skips boards with a null workspaceId when config.workspaceIds is set', async () => {
    const fake = fakeDrive();
    await runBackup(
      deps({
        monday: fakeMonday({ listBoards: async () => [board('1', 'Board 1', 'ws-1'), board('2', 'Board 2', null)] }),
        drive: fake.drive,
        config: { destinationParentFolderId: 'parent-1', excludeBoardIds: [], workspaceIds: ['ws-1'] },
      }),
    );
    expect(fake.filenames()).toEqual(['board-1.jsonl', 'manifest.json']);
  });

  it('skips docs outside config.workspaceIds when set', async () => {
    const fake = fakeDrive();
    await runBackup(
      deps({
        monday: fakeMonday({ listDocs: async () => [doc('d1', 'Doc 1', 'ws-1'), doc('d2', 'Doc 2', 'ws-2')] }),
        drive: fake.drive,
        config: { destinationParentFolderId: 'parent-1', excludeBoardIds: [], workspaceIds: ['ws-1'] },
      }),
    );
    expect(fake.filenames()).toEqual(['doc-d1.jsonl', 'manifest.json']); // doc d2 (ws-2) filtered out
  });

  it('applies no workspace filter when config.workspaceIds is absent or empty', async () => {
    const fake = fakeDrive();
    await runBackup(
      deps({
        monday: fakeMonday({
          listBoards: async () => [board('1', 'Board 1', 'ws-1'), board('2', 'Board 2', 'ws-2')],
          listDocs: async () => [doc('d1', 'Doc 1', 'ws-1'), doc('d2', 'Doc 2', null)],
        }),
        drive: fake.drive,
        config: { destinationParentFolderId: 'parent-1', excludeBoardIds: [], workspaceIds: [] },
      }),
    );
    expect(fake.filenames()).toEqual(['board-1.jsonl', 'board-2.jsonl', 'doc-d1.jsonl', 'doc-d2.jsonl', 'manifest.json']);
  });

  it('records a board failure in the manifest, continues, and alerts on any partial run', async () => {
    const monday = fakeMonday({
      listBoards: async () => [board('1'), board('2')],
      getBoardSchema: async (boardId) => {
        if (boardId === '1') throw new Error('monday API: HTTP 500');
        return { columns: [], groups: [] };
      },
    });
    const fake = fakeDrive();
    const runStore = fakeRunStore();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    await runBackup(deps({ monday, drive: fake.drive, runStore, slackWebhookUrl: 'https://hooks.example/webhook' }));

    expect(fake.filenames()).toEqual(['board-2.jsonl', 'manifest.json']); // board 1 skipped, board 2 still uploaded
    expect((fake.manifest().errors as string[])[0]).toContain('board 1');

    expect(runStore.finishes[0]).toMatchObject({ status: 'partial', boardCount: 1, errorCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // Slack alert fired immediately
    const alertBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(alertBody.text).toContain('partial snapshot');
    expect(alertBody.text).toContain('board 1');
  });

  it('records a total failure and rethrows when the run aborts entirely', async () => {
    const drive = fakeDrive({
      ensureFolder: async () => {
        throw new Error('Drive API: HTTP 401 — invalid_grant');
      },
    }).drive;
    const runStore = fakeRunStore();

    await expect(runBackup(deps({ drive, runStore }))).rejects.toThrow(/invalid_grant/);

    expect(runStore.failures).toEqual(['Drive API: HTTP 401 — invalid_grant']);
    expect(runStore.finishes).toEqual([]);
  });

  it('alerts on the very first total failure, and on every one after, with the streak length', async () => {
    const drive = fakeDrive({
      ensureFolder: async () => {
        throw new Error('outage');
      },
    }).drive;
    const runStore = fakeRunStore();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const run = () => runBackup(deps({ drive, runStore, slackWebhookUrl: 'https://hooks.example/webhook' }));

    await expect(run()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no three-night grace period (issue #29)
    const first = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(first.text).toContain('run failed');
    expect(first.text).toContain('outage');

    await expect(run()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(second.text).toContain('2 nights in a row');
  });
});
