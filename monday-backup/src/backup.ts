import { sendFailureAlert } from './alert';
import { BUDGET_EXHAUSTED, BudgetExhaustedError, Deadline } from './deadline';
import { SNAPSHOT_FORMAT } from './format';
import type { DriveClient, DriveFileWriter } from './drive/client';
import type { SnapshotRunStore } from './db/runs';
import type { MondayClient } from './monday/client';
import type { BackupConfig, BoardSchema, BoardSummary, DocSummary } from './types';
import { errorMessage } from './util/errorMessage';

// Re-exported for existing importers; the layout is documented in ./format.
export { SNAPSHOT_FORMAT };
const JSONL = 'application/x-ndjson';

// Cron invocations are killed at 15 minutes of wall time, and like a CPU-limit kill that is not
// catchable (issue #29). Three marks, relative to the run's start:
//  - 12 min (the budget): start no new board or doc;
//  - +1 min (13): the shared Deadline — any Monday/Drive call still retrying gives up with
//    BudgetExhaustedError instead of sleeping or waiting past it;
//  - +2.5 min (14.5): the Deadline is extended for the finalize phase, so the manifest upload,
//    the D1 finish row and the partial-run alert still land before the kill.
const DEFAULT_WALL_TIME_BUDGET_MS = 12 * 60_000;
const IN_FLIGHT_GRACE_MS = 60_000;
const FINALIZE_GRACE_MS = 150_000;

export interface BackupDeps {
  monday: MondayClient;
  drive: DriveClient;
  runStore: SnapshotRunStore;
  config: BackupConfig;
  slackWebhookUrl: string;
  now: () => Date;
  wallTimeBudgetMs?: number;
  // Shared with the Monday and Drive clients (src/index.ts); runBackup sets its phases.
  deadline?: Deadline;
}

const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;

// Writes one file through `produce`, closing it on success and cancelling the upload on failure
// so a half-written board never shows up in Drive looking complete.
async function streamFile(
  drive: DriveClient,
  folderId: string,
  filename: string,
  produce: (writer: DriveFileWriter) => Promise<void>,
): Promise<void> {
  const writer = await drive.createFile(folderId, filename, JSONL);
  try {
    await produce(writer);
    await writer.close();
  } catch (err) {
    await writer.abort();
    throw err;
  }
}

// A board's subitems live on a separate sub_items_board, named in its `subtasks` column settings.
function subitemBoardIds(schema: BoardSchema): string[] {
  const ids: string[] = [];
  for (const column of schema.columns) {
    if (column.type !== 'subtasks') continue;
    try {
      const settings = JSON.parse(column.settingsStr) as { boardIds?: (string | number)[] };
      for (const id of settings.boardIds ?? []) ids.push(String(id));
    } catch {
      // Unparseable settings: nothing to discover; the board itself still backs up.
    }
  }
  return ids;
}

async function backupBoard(
  deps: BackupDeps,
  folderId: string,
  board: BoardSummary,
  pastDeadline: () => boolean,
): Promise<{ itemCount: number; updateCount: number; subitemBoardIds: string[] }> {
  const schema = await deps.monday.getBoardSchema(board.id);
  let itemCount = 0;
  let updateCount = 0;
  await streamFile(deps.drive, folderId, `board-${board.id}.jsonl`, async (writer) => {
    await writer.write(line({ type: 'board', board, schema }));
    for await (const page of deps.monday.boardItemPages(board.id)) {
      // One write per page: memory holds a single page, never the whole board.
      await writer.write(page.map((item) => line({ type: 'item', item })).join(''));
      itemCount += page.length;
      if (pastDeadline()) throw new Error(`stopped mid-board — ${BUDGET_EXHAUSTED}`);
    }
    // Updates after items, so a restore has created every item before it replays comments.
    for await (const page of deps.monday.boardUpdatePages(board.id)) {
      await writer.write(page.map((update) => line({ type: 'update', update })).join(''));
      updateCount += page.length;
      if (pastDeadline()) throw new Error(`stopped mid-board — ${BUDGET_EXHAUSTED}`);
    }
  });
  return { itemCount, updateCount, subitemBoardIds: subitemBoardIds(schema) };
}

async function backupDoc(deps: BackupDeps, folderId: string, doc: DocSummary, pastDeadline: () => boolean): Promise<number> {
  let blockCount = 0;
  await streamFile(deps.drive, folderId, `doc-${doc.id}.jsonl`, async (writer) => {
    await writer.write(line({ type: 'doc', doc }));
    for await (const page of deps.monday.docBlockPages(doc.id)) {
      await writer.write(page.map((block) => line({ type: 'block', block })).join(''));
      blockCount += page.length;
      if (pastDeadline()) throw new Error(`stopped mid-doc — ${BUDGET_EXHAUSTED}`);
    }
  });
  return blockCount;
}

export async function runBackup(deps: BackupDeps): Promise<void> {
  const startedAtUtc = deps.now().toISOString();
  const runId = await deps.runStore.recordRunStart(startedAtUtc);
  // One folder per run, e.g. "2026-08-25 run-17": sorts by date in Drive, and a same-day rerun
  // gets its own folder instead of a second set of same-named files beside the first (#29).
  const snapshotFolder = `${startedAtUtc.slice(0, 10)} run-${runId}`;

  // Belt-and-braces alongside the workspace-scoped sandbox token (design doc §4): when set and
  // non-empty, skip anything outside the listed workspace(s). Absent/empty preserves today's
  // "snapshot everything the token can see" behaviour.
  const workspaceIds = deps.config.workspaceIds;
  const inScope = (workspaceId: string | null): boolean =>
    workspaceIds === undefined || workspaceIds.length === 0 || (workspaceId !== null && workspaceIds.includes(workspaceId));

  const budgetEndsAt = Date.parse(startedAtUtc) + (deps.wallTimeBudgetMs ?? DEFAULT_WALL_TIME_BUDGET_MS);
  const pastDeadline = (): boolean => deps.now().getTime() >= budgetEndsAt;
  const clientDeadline = deps.deadline ?? new Deadline();
  clientDeadline.atMs = budgetEndsAt + IN_FLIGHT_GRACE_MS;

  try {
    const folderId = await deps.drive.ensureFolder(deps.config.destinationParentFolderId, snapshotFolder);

    const errors: string[] = [];
    const itemCountsByBoard: Record<string, number> = {};
    const updateCountsByBoard: Record<string, number> = {};
    const blockCountsByDoc: Record<string, number> = {};
    let boardCount = 0;
    let docCount = 0;

    const deletedBoardsSkipped: string[] = [];

    // Running out of budget while *listing* still ends as a recorded partial run, not a total
    // failure; any other listing error is a real failure and propagates.
    const listWithinBudget = async <T>(what: string, list: () => Promise<T[]>): Promise<T[]> => {
      if (pastDeadline()) {
        errors.push(`${what}: skipped — ${BUDGET_EXHAUSTED}`);
        return [];
      }
      try {
        return await list();
      } catch (err) {
        if (!(err instanceof BudgetExhaustedError)) throw err;
        errors.push(`${what}: ${errorMessage(err)}`);
        return [];
      }
    };

    // A queue, not a plain loop: backing up a board can discover its subitems board, which is
    // appended if `boards` didn't already list it (issue #30).
    const boards = await listWithinBudget('boards', () => deps.monday.listBoards());
    const queued = new Set(boards.map((b) => b.id));
    for (let i = 0; i < boards.length; i++) {
      const board = boards[i]!;
      if (deps.config.excludeBoardIds.includes(board.id)) continue;
      if (!inScope(board.workspaceId)) continue;
      // Deleted boards sit in Monday's own 30-day trash (restorable there); their items can't be
      // paged, so trying would only turn every nightly run partial.
      if (board.state === 'deleted') {
        deletedBoardsSkipped.push(board.id);
        continue;
      }
      if (pastDeadline()) {
        errors.push(`board ${board.id} (${board.name}): skipped — ${BUDGET_EXHAUSTED}`);
        continue;
      }
      try {
        const result = await backupBoard(deps, folderId, board, pastDeadline);
        itemCountsByBoard[board.id] = result.itemCount;
        updateCountsByBoard[board.id] = result.updateCount;
        boardCount++;
        for (const subBoardId of result.subitemBoardIds) {
          if (queued.has(subBoardId)) continue;
          queued.add(subBoardId);
          boards.push({
            id: subBoardId,
            name: `Subitems of ${board.name}`,
            workspaceId: board.workspaceId,
            state: board.state ?? null,
            type: 'sub_items_board',
            parentBoardId: board.id,
          });
        }
      } catch (err) {
        const message = errorMessage(err);
        errors.push(`board ${board.id} (${board.name}): ${message}`);
        console.error(`monday-backup: board ${board.id} failed: ${message}`);
      }
    }

    const docs = await listWithinBudget('docs', () => deps.monday.listDocs());
    for (const doc of docs) {
      if (!inScope(doc.workspaceId)) continue;
      if (pastDeadline()) {
        errors.push(`doc ${doc.id} (${doc.name}): skipped — ${BUDGET_EXHAUSTED}`);
        continue;
      }
      try {
        blockCountsByDoc[doc.id] = await backupDoc(deps, folderId, doc, pastDeadline);
        docCount++;
      } catch (err) {
        const message = errorMessage(err);
        errors.push(`doc ${doc.id} (${doc.name}): ${message}`);
        console.error(`monday-backup: doc ${doc.id} failed: ${message}`);
      }
    }

    // Written last, after every board/doc attempt, so a partial run is obvious from the
    // manifest itself rather than discovered only at restore time (per README's ask).
    clientDeadline.atMs = budgetEndsAt + FINALIZE_GRACE_MS; // finalize phase: room for the manifest
    await deps.drive.uploadJson(folderId, 'manifest.json', {
      format: SNAPSHOT_FORMAT,
      runId,
      snapshotFolder,
      runAt: startedAtUtc,
      boardCount,
      docCount,
      itemCountsByBoard,
      updateCountsByBoard,
      blockCountsByDoc,
      deletedBoardsSkipped,
      errors,
    });

    const finishedAtUtc = deps.now().toISOString();
    await deps.runStore.recordRunFinish(runId, finishedAtUtc, {
      status: errors.length === 0 ? 'success' : 'partial',
      boardCount,
      docCount,
      errorCount: errors.length,
      lastError: errors.length > 0 ? (errors[errors.length - 1] ?? null) : null,
    });

    // A partial snapshot is the failure mode this Worker exists to make visible — alert on
    // every occurrence, same as the total-failure case below.
    if (errors.length > 0) {
      const detail = errors.length > 5 ? `${errors.slice(0, 5).join('; ')} (+${errors.length - 5} more)` : errors.join('; ');
      await sendFailureAlert(deps.slackWebhookUrl, `partial snapshot — ${errors.length} board/doc(s) failed`, detail);
    }
  } catch (err) {
    const message = errorMessage(err);
    console.error(`monday-backup: run failed: ${message}`);
    const finishedAtUtc = deps.now().toISOString();
    const consecutiveFailures = await deps.runStore.recordRunFailure(runId, finishedAtUtc, message);
    // Alert on the first total failure (issue #29): a backup that silently skips up to three
    // nights before anyone hears about it is three nights of unrecoverable edits.
    const streak = consecutiveFailures > 1 ? ` (${consecutiveFailures} nights in a row)` : '';
    await sendFailureAlert(deps.slackWebhookUrl, `run failed — no snapshot was written${streak}`, message);
    throw err;
  }
}
