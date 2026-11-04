import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSnapshot, SNAPSHOT_FORMAT, type BackupDeps, type SnapshotStep } from './backup';
import type { RunResult, SnapshotRunStore } from './db/runs';
import type { DriveClient } from './drive/client';
import { Deadline } from './deadline';
import { HttpMondayClient, type MondayClient } from './monday/client';
import { RequestStats } from './monday/requestStats';
import type { BackupConfig, BoardSummary, DocSummary, ItemRecord } from './types';

// Stands in for Cloudflare's WorkflowStep: results are saved by name and answered from there on a
// replay, returned through JSON as the real ones are, and a failing step gets the same three tries.
function fakeStep() {
  const saved = new Map<string, unknown>();
  const failed = new Map<string, unknown>();
  const ran: string[] = [];
  const step: SnapshotStep = {
    do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      if (saved.has(name)) return saved.get(name) as T;
      if (failed.has(name)) throw failed.get(name);
      ran.push(name);
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = (await fn()) as unknown;
          const stored = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
          saved.set(name, stored);
          return stored as T;
        } catch (err) {
          lastError = err;
        }
      }
      failed.set(name, lastError);
      throw lastError;
    },
  };
  return { step, ran, saved };
}

const runBackup = (d: BackupDeps) => runSnapshot(fakeStep().step, d);

function fakeMonday(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    listBoards: async () => [],
    getBoardSchema: async () => ({ columns: [], groups: [] }),
    async *boardItemPages() {},
    async *boardUpdatePages() {},
    listDocs: async () => [],
    async *docBlockPages() {},
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
    findFile: async (folderId, filename) =>
      files.some((f) => f.closed && f.folderId === folderId && f.filename === filename)
        ? { id: `${folderId}/${filename}`, createdTime: '2026-08-25T08:59:00.000Z' }
        : null,
    async *readLines(fileId) {
      const file = files.find((f) => f.closed && `${f.folderId}/${f.filename}` === fileId)!;
      yield* file.writes.join('').split('\n').filter((l) => l !== '');
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

function fakeRunStore(): SnapshotRunStore & { finishes: RunResult[]; failures: string[]; stops: string[]; starts: string[] } {
  const finishes: RunResult[] = [];
  const failures: string[] = [];
  const stops: string[] = [];
  const starts: string[] = [];
  return {
    recordRunStart: async (startedAtUtc) => {
      starts.push(startedAtUtc);
      return 1;
    },
    recordRunFinish: async (_runId, _finishedAtUtc, result) => {
      finishes.push(result);
    },
    recordRunFailure: async (_runId, _finishedAtUtc, errorMessage) => {
      failures.push(errorMessage);
      return failures.length;
    },
    recordRunStopped: async (_runId, _finishedAtUtc, reason) => {
      stops.push(reason);
    },
    finishes,
    failures,
    stops,
    starts,
  };
}

const config: BackupConfig = { destinationParentFolderId: 'parent-1', excludeBoardIds: [], apiUsageAlerts: false };

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
      async *docBlockPages() {
        yield [{ id: 'b1', type: 'normal_text', content: '{}' }];
      },
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
        config: { destinationParentFolderId: 'parent-1', excludeBoardIds: ['98'], apiUsageAlerts: false },
      }),
    );
    expect(fake.filenames()).toEqual(['board-1.jsonl', 'board-2.jsonl', 'board-99.jsonl', 'manifest.json']);
    const header = fake.records('board-99.jsonl')[0]!;
    expect(header.board).toMatchObject({ id: '99', type: 'sub_items_board', workspaceId: 'ws-1', parentBoardId: '1' });
    expect((fake.records('board-99.jsonl')[1]!.item as ItemRecord).parentItemId).toBe('p1');
  });

  it("appends the board's updates after its items, and counts them in the manifest", async () => {
    const update = (id: string, itemId: string | null) => ({
      id,
      itemId,
      body: '<p>hi</p>',
      textBody: 'hi',
      createdAt: null,
      updatedAt: null,
      creatorId: null,
      replies: [],
      assets: [],
    });
    const fake = fakeDrive();
    await runBackup(
      deps({
        monday: fakeMonday({
          listBoards: async () => [board('1')],
          async *boardItemPages() {
            yield [item('a')];
          },
          async *boardUpdatePages() {
            yield [update('u1', 'a'), update('u2', null)];
            yield [update('u3', 'a')];
          },
        }),
        drive: fake.drive,
      }),
    );
    expect(fake.records('board-1.jsonl').map((r) => r.type)).toEqual(['board', 'item', 'update', 'update', 'update']);
    expect(fake.manifest().updateCountsByBoard).toEqual({ '1': 3 });
  });

  // A single Monday call stuck retrying (slow 5xx responses, backoff) must fail with a clear message
  // inside its step's window, and leave later boards their own window.
  it('a call stuck retrying gives up at the step deadline, and the next board gets a fresh one', async () => {
    let t = Date.parse('2026-08-25T09:00:00.000Z');
    const deadline = new Deadline(Number.POSITIVE_INFINITY, () => t);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const { query, variables } = JSON.parse(init.body as string) as { query: string; variables: { boardId?: string[] } };
        if (query.includes('workspace_id') && query.includes('state: all')) {
          return Response.json({
            data: {
              boards: [
                { id: '1', name: 'People', workspace_id: 'ws-1', state: 'active' },
                { id: '2', name: 'Events', workspace_id: 'ws-1', state: 'active' },
              ],
            },
          });
        }
        if (query.includes('settings_str')) return Response.json({ data: { boards: [{ columns: [], groups: [] }] } });
        if (query.includes('docs(')) return Response.json({ data: { docs: [] } });
        if (query.includes('updates(')) return Response.json({ data: { boards: [{ updates: [] }] } });
        if (variables.boardId?.[0] === '2') return Response.json({ data: { boards: [{ items_page: { cursor: null, items: [] } }] } });
        t += 10 * 60_000; // board 1's items: every attempt takes ten minutes, then 503s
        return new Response('upstream timeout', { status: 503 });
      }),
    );
    const monday = new HttpMondayClient('https://api.monday.com/v2', 'token', { deadline, maxAttempts: 10, sleepFn: async (ms) => void (t += ms) });
    const fake = fakeDrive();
    const runStore = fakeRunStore();

    await runBackup(deps({ monday, drive: fake.drive, runStore, deadline, now: () => new Date(t) }));

    expect((fake.manifest().errors as string[])[0]).toMatch(/^board 1 \(People\): wall-time budget exhausted/);
    expect(fake.filenames()).toEqual(['board-2.jsonl', 'manifest.json']);
    expect(runStore.finishes).toEqual([expect.objectContaining({ status: 'partial', boardCount: 1, errorCount: 1 })]);
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
        config: { destinationParentFolderId: 'parent-1', excludeBoardIds: ['2'], apiUsageAlerts: false },
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
        config: { destinationParentFolderId: 'parent-1', excludeBoardIds: [], workspaceIds: ['ws-1'], apiUsageAlerts: false },
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
        config: { destinationParentFolderId: 'parent-1', excludeBoardIds: [], workspaceIds: ['ws-1'], apiUsageAlerts: false },
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
        config: { destinationParentFolderId: 'parent-1', excludeBoardIds: [], workspaceIds: ['ws-1'], apiUsageAlerts: false },
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
        config: { destinationParentFolderId: 'parent-1', excludeBoardIds: [], workspaceIds: [], apiUsageAlerts: false },
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

  describe('as a Workflow', () => {
    const counted = fakeMonday({
      listBoards: async () => [board('1'), board('2')],
      async *boardItemPages(boardId) {
        yield [item(`${boardId}-a`), item(`${boardId}-b`)];
      },
      listDocs: async () => [doc('d1')],
      async *docBlockPages() {
        yield [{ id: 'b1', type: 'normal_text', content: '{}' }];
      },
    });

    it('names one step per board and doc', async () => {
      const { step, ran } = fakeStep();
      await runSnapshot(step, deps({ monday: counted, drive: fakeDrive().drive }));
      expect(ran).toEqual(['start', 'folder', 'list boards', 'list docs', 'board 1', 'board 2', 'doc d1', 'manifest', 'finish']);
    });

    // A step that closed its upload and then failed before returning runs again. Drive would accept a
    // second file of the same name, and the service account can't delete one.
    it('a step repeated after its upload closed reuses the file, with its counts and subitems', async () => {
      const subtasks = { id: 's', title: 'Subitems', type: 'subtasks', settingsStr: '{"boardIds":[99]}' };
      const fake = fakeDrive();
      const inner = fakeStep().step;
      let failedOnce = false;
      const step: SnapshotStep = {
        do: (name, fn) =>
          inner.do(name, async () => {
            const result = await fn();
            if (name === 'board 1' && !failedOnce) {
              failedOnce = true;
              throw new Error('lost the step result');
            }
            return result;
          }),
      };
      await runSnapshot(
        step,
        deps({
          monday: fakeMonday({
            listBoards: async () => [board('1')],
            getBoardSchema: async (id) => ({ columns: id === '1' ? [subtasks] : [], groups: [] }),
            async *boardItemPages(id) {
              if (id === '1') yield [item('a'), item('b')];
            },
            async *boardUpdatePages(id) {
              if (id === '1') yield [{ id: 'u', itemId: 'a', body: '', textBody: null, createdAt: null, updatedAt: null, creatorId: null, replies: [], assets: [] }];
            },
          }),
          drive: fake.drive,
        }),
      );
      expect(fake.files.filter((f) => f.filename === 'board-1.jsonl')).toHaveLength(1);
      expect(fake.manifest()).toMatchObject({ itemCountsByBoard: { '1': 2, '99': 0 }, updateCountsByBoard: { '1': 1 }, errors: [] });
      expect((fake.manifest().capturedAt as Record<string, unknown>)['board-1']).toEqual({
        startedAt: '2026-08-25T08:59:00.000Z',
        finishedAt: '2026-08-25T08:59:00.000Z',
      });
    });

    it('a doc step repeated after its upload closed reuses the file too', async () => {
      const fake = fakeDrive();
      const inner = fakeStep().step;
      let failedOnce = false;
      const step: SnapshotStep = {
        do: (name, fn) =>
          inner.do(name, async () => {
            const result = await fn();
            if (name === 'doc d1' && !failedOnce) {
              failedOnce = true;
              throw new Error('lost the step result');
            }
            return result;
          }),
      };
      await runSnapshot(step, deps({ monday: counted, drive: fake.drive }));
      expect(fake.files.filter((f) => f.filename === 'doc-d1.jsonl')).toHaveLength(1);
      expect(fake.manifest().blockCountsByDoc).toEqual({ d1: 1 });
    });

    it('a manifest step repeated after its upload does not leave a second manifest', async () => {
      const fake = fakeDrive();
      const inner = fakeStep().step;
      let failedOnce = false;
      const step: SnapshotStep = {
        do: (name, fn) =>
          inner.do(name, async () => {
            const result = await fn();
            if (name === 'manifest' && !failedOnce) {
              failedOnce = true;
              throw new Error('lost the step result');
            }
            return result;
          }),
      };
      await runSnapshot(step, deps({ monday: counted, drive: fake.drive }));
      expect(fake.files.filter((f) => f.filename === 'manifest.json')).toHaveLength(1);
    });

    // Workflows can hibernate and lose all memory; run() then replays from the top.
    it('a replay runs only unfinished steps, and rebuilds the counts from saved results', async () => {
      const fake = fakeDrive();
      const runStore = fakeRunStore();
      const { step, ran } = fakeStep();
      let reachedBoard2!: () => void;
      const atBoard2 = new Promise<void>((resolve) => (reachedBoard2 = resolve));
      const hibernating: SnapshotStep = {
        do: (name, fn) => {
          if (name !== 'board 2') return step.do(name, fn);
          reachedBoard2();
          return new Promise(() => {}); // this invocation is gone, and never continues
        },
      };
      const d = deps({ monday: counted, drive: fake.drive, runStore });
      void runSnapshot(hibernating, d);
      await atBoard2;
      expect(ran).toEqual(['start', 'folder', 'list boards', 'list docs', 'board 1']);
      ran.length = 0;

      await runSnapshot(step, d);

      expect(ran).toEqual(['board 2', 'doc d1', 'manifest', 'finish']);
      expect(fake.manifest()).toMatchObject({ boardCount: 2, itemCountsByBoard: { '1': 2, '2': 2 }, blockCountsByDoc: { d1: 1 } });
      expect(runStore.starts).toHaveLength(1);
    });

    it('a board that exhausts its retries is recorded, and the run carries on', async () => {
      const attempts: string[] = [];
      const fake = fakeDrive();
      const runStore = fakeRunStore();
      await runBackup(
        deps({
          monday: fakeMonday({
            listBoards: async () => [board('1'), board('2')],
            getBoardSchema: async (id) => {
              attempts.push(id);
              if (id === '1') throw new Error('nope');
              return { columns: [], groups: [] };
            },
          }),
          drive: fake.drive,
          runStore,
        }),
      );
      expect(attempts).toEqual(['1', '1', '1', '2']);
      expect(fake.manifest().errors).toEqual(['board 1 (Board 1): nope']);
      expect(runStore.finishes[0]).toMatchObject({ status: 'partial', boardCount: 1, errorCount: 1 });
    });

    it.each([
      ['missing from the listing', [board('1')]],
      ['deleted', [board('1'), { ...board('7'), state: 'deleted' }]],
    ])('a required board that is %s makes the run partial, even with every visible board captured', async (_label, boards) => {
      const fake = fakeDrive();
      const runStore = fakeRunStore();
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);
      await runBackup(
        deps({
          monday: fakeMonday({ listBoards: async () => boards }),
          drive: fake.drive,
          runStore,
          slackWebhookUrl: 'https://hooks.example/webhook',
          config: { ...config, requiredBoardIds: ['1', '7'] },
        }),
      );
      expect(fake.manifest().errors).toEqual(['board 7: required but not visible to this token']);
      expect(runStore.finishes[0]).toMatchObject({ status: 'partial', boardCount: 1, errorCount: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('all required boards present is a success', async () => {
      const runStore = fakeRunStore();
      await runBackup(
        deps({ monday: counted, drive: fakeDrive().drive, runStore, config: { ...config, requiredBoardIds: ['1', '2'] } }),
      );
      expect(runStore.finishes[0]).toMatchObject({ status: 'success', errorCount: 0 });
    });

    it('captures priority workspaces first, otherwise in listed order', async () => {
      const { step, ran } = fakeStep();
      await runSnapshot(
        step,
        deps({
          monday: fakeMonday({
            listBoards: async () => [board('a', 'A', 'ws-1'), board('b', 'B', 'crm'), board('c', 'C', 'ws-2'), board('d', 'D', 'crm'), board('e', 'E', null)],
            listDocs: async () => [doc('x', 'X', 'ws-1'), doc('y', 'Y', 'crm')],
          }),
          drive: fakeDrive().drive,
          config: { ...config, priorityWorkspaceIds: ['crm'] },
        }),
      );
      expect(ran.filter((n) => n.startsWith('board ') || n.startsWith('doc '))).toEqual([
        'board b',
        'board d',
        'board a',
        'board c',
        'board e',
        'doc y',
        'doc x',
      ]);
    });

    it('the switch off at the start skips the run with no row, folder or file', async () => {
      const fake = fakeDrive({
        ensureFolder: async () => {
          throw new Error('should not be called');
        },
      });
      const runStore = fakeRunStore();
      await runBackup(deps({ monday: counted, drive: fake.drive, runStore, writesOn: async () => false }));
      expect(runStore.starts).toEqual([]);
      expect(runStore.finishes).toEqual([]);
      expect(runStore.failures).toEqual([]);
    });

    it.each([
      ['a board', 3],
      ['a doc', 4],
    ])('the switch flipped before %s stops the run: stopped, no manifest, no alert', async (_label, readsUntilOff) => {
      const fake = fakeDrive();
      const runStore = fakeRunStore();
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);
      let reads = 0;
      await runBackup(
        deps({
          monday: counted,
          drive: fake.drive,
          runStore,
          slackWebhookUrl: 'https://hooks.example/webhook',
          writesOn: async () => ++reads < readsUntilOff,
        }),
      );
      expect(fake.filenames()).not.toContain('manifest.json');
      expect(runStore.stops).toHaveLength(1);
      expect(runStore.finishes).toEqual([]);
      expect(runStore.failures).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('the manifest records the window and when each board and doc was captured', async () => {
      let t = Date.parse('2026-08-25T09:00:00.000Z');
      const fake = fakeDrive();
      await runBackup(
        deps({
          monday: fakeMonday({
            listBoards: async () => [board('1')],
            async *boardItemPages() {
              t += 60_000;
              yield [item('a')];
            },
            listDocs: async () => [doc('d1')],
            async *docBlockPages() {
              t += 60_000;
              yield [{ id: 'b1', type: 'normal_text', content: '{}' }];
            },
          }),
          drive: fake.drive,
          now: () => new Date(t),
        }),
      );
      expect(fake.manifest()).toMatchObject({
        format: 'monday-backup/2',
        runAt: '2026-08-25T09:00:00.000Z',
        finishedAt: '2026-08-25T09:02:00.000Z',
        capturedAt: {
          'board-1': { startedAt: '2026-08-25T09:00:00.000Z', finishedAt: '2026-08-25T09:01:00.000Z' },
          'doc-d1': { startedAt: '2026-08-25T09:01:00.000Z', finishedAt: '2026-08-25T09:02:00.000Z' },
        },
      });
    });

    it('logs each file with its requests and retries', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stats = new RequestStats();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
      const monday = fakeMonday({
        listBoards: async () => [board('1')],
        async *boardItemPages() {
          await stats.fetchFn('https://x', { method: 'POST', body: 'q' });
          await stats.fetchFn('https://x', { method: 'POST', body: 'q' });
          yield [item('a')];
        },
      });
      await runBackup(deps({ monday, drive: fakeDrive().drive, requestStats: stats }));
      const logged = logSpy.mock.calls.map(([l]) => String(l));
      expect(logged.some((l) => l.includes('board-1.jsonl items=1 updates=0') && l.includes('requests=2 retries=1'))).toBe(true);
      logSpy.mockRestore();
    });
  });
});
