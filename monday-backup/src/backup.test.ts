import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBackup } from './backup';
import type { RunResult, SnapshotRunStore } from './db/runs';
import type { DriveClient } from './drive/client';
import type { MondayClient } from './monday/client';
import type { BackupConfig, BoardSummary, DocSummary } from './types';

function fakeMonday(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    listBoards: async () => [],
    getBoardSchema: async () => ({ columns: [], groups: [] }),
    getBoardItems: async () => [],
    listDocs: async () => [],
    getDocBlocks: async () => [],
    ...overrides,
  };
}

function fakeDrive(overrides: Partial<DriveClient> = {}): DriveClient & { uploads: { folderId: string; filename: string; data: unknown }[] } {
  const uploads: { folderId: string; filename: string; data: unknown }[] = [];
  return {
    ensureDatedFolder: async () => 'folder-1',
    uploadJson: async (folderId, filename, data) => {
      uploads.push({ folderId, filename, data });
    },
    uploads,
    ...overrides,
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

function board(id: string, name = `Board ${id}`): BoardSummary {
  return { id, name, workspaceId: 'ws-1' };
}

function doc(id: string, name = `Doc ${id}`): DocSummary {
  return { id, name, workspaceId: 'ws-1', url: null };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runBackup', () => {
  it('uploads every board and doc plus a manifest, and records a success run', async () => {
    const monday = fakeMonday({
      listBoards: async () => [board('1'), board('2')],
      getBoardItems: async (boardId) => [{ id: `item-${boardId}`, name: 'x', groupId: null, columnValues: [] }],
      listDocs: async () => [doc('d1')],
    });
    const drive = fakeDrive();
    const runStore = fakeRunStore();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    await runBackup({
      monday,
      drive,
      runStore,
      config,
      slackWebhookUrl: 'https://hooks.example/webhook',
      now: () => new Date('2026-08-25T09:00:00.000Z'),
    });

    const filenames = drive.uploads.map((u) => u.filename);
    expect(filenames).toEqual(['board-1.json', 'board-2.json', 'doc-d1.json', 'manifest.json']);
    expect(drive.uploads.every((u) => u.folderId === 'folder-1')).toBe(true);

    const manifest = drive.uploads.find((u) => u.filename === 'manifest.json')!.data as {
      boardCount: number;
      docCount: number;
      errors: string[];
    };
    expect(manifest.boardCount).toBe(2);
    expect(manifest.docCount).toBe(1);
    expect(manifest.errors).toEqual([]);

    expect(runStore.finishes).toEqual([{ status: 'success', boardCount: 2, docCount: 1, errorCount: 0, lastError: null }]);
    expect(fetchMock).not.toHaveBeenCalled(); // no partial-run alert sent
  });

  it('skips boards listed in excludeBoardIds', async () => {
    const monday = fakeMonday({ listBoards: async () => [board('1'), board('2')] });
    const drive = fakeDrive();
    const runStore = fakeRunStore();

    await runBackup({
      monday,
      drive,
      runStore,
      config: { destinationParentFolderId: 'parent-1', excludeBoardIds: ['2'] },
      slackWebhookUrl: '',
      now: () => new Date('2026-08-25T09:00:00.000Z'),
    });

    const filenames = drive.uploads.map((u) => u.filename);
    expect(filenames).toEqual(['board-1.json', 'manifest.json']);
  });

  it('records a board failure in the manifest, continues, and alerts on any partial run', async () => {
    const monday = fakeMonday({
      listBoards: async () => [board('1'), board('2')],
      getBoardSchema: async (boardId) => {
        if (boardId === '1') throw new Error('monday API: HTTP 500');
        return { columns: [], groups: [] };
      },
    });
    const drive = fakeDrive();
    const runStore = fakeRunStore();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    await runBackup({
      monday,
      drive,
      runStore,
      config,
      slackWebhookUrl: 'https://hooks.example/webhook',
      now: () => new Date('2026-08-25T09:00:00.000Z'),
    });

    const filenames = drive.uploads.map((u) => u.filename);
    expect(filenames).toEqual(['board-2.json', 'manifest.json']); // board 1 skipped, board 2 still uploaded

    expect(runStore.finishes[0]).toMatchObject({ status: 'partial', boardCount: 1, errorCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // Slack alert fired immediately
    const alertBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(alertBody.text).toContain('partial snapshot');
    expect(alertBody.text).toContain('board 1');
  });

  it('records a total failure and rethrows when the run aborts entirely', async () => {
    const monday = fakeMonday();
    const drive = fakeDrive({
      ensureDatedFolder: async () => {
        throw new Error('Drive API: HTTP 401 — invalid_grant');
      },
    });
    const runStore = fakeRunStore();

    await expect(
      runBackup({
        monday,
        drive,
        runStore,
        config,
        slackWebhookUrl: '',
        now: () => new Date('2026-08-25T09:00:00.000Z'),
      }),
    ).rejects.toThrow(/invalid_grant/);

    expect(runStore.failures).toEqual(['Drive API: HTTP 401 — invalid_grant']);
    expect(runStore.finishes).toEqual([]);
  });

  it('alerts once consecutive total failures reach the threshold', async () => {
    const monday = fakeMonday();
    const drive = fakeDrive({
      ensureDatedFolder: async () => {
        throw new Error('outage');
      },
    });
    const runStore = fakeRunStore();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 3; i++) {
      await expect(
        runBackup({ monday, drive, runStore, config, slackWebhookUrl: 'https://hooks.example/webhook', now: () => new Date() }),
      ).rejects.toThrow();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1); // only fired on the 3rd consecutive failure
  });
});
