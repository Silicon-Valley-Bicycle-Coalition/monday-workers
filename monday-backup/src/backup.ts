import { sendFailureAlert } from './alert';
import type { DriveClient, DriveFileWriter } from './drive/client';
import type { SnapshotRunStore } from './db/runs';
import type { MondayClient } from './monday/client';
import type { BackupConfig, BoardSummary, DocSummary } from './types';
import { errorMessage } from './util/errorMessage';

// Snapshot layout, recorded in every manifest so a restore tool can tell what it is reading.
// v2: one JSON Lines file per board and per doc, streamed page by page (issue #29) — each line is
// a self-describing record `{ type, <type>: payload }` (payloads are nested, never spread, since
// Monday objects carry their own `type` fields); the first line is always the board/doc header.
export const SNAPSHOT_FORMAT = 'monday-backup/2';
const JSONL = 'application/x-ndjson';

export interface BackupDeps {
  monday: MondayClient;
  drive: DriveClient;
  runStore: SnapshotRunStore;
  config: BackupConfig;
  slackWebhookUrl: string;
  now: () => Date;
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

async function backupBoard(deps: BackupDeps, folderId: string, board: BoardSummary): Promise<number> {
  const schema = await deps.monday.getBoardSchema(board.id);
  let itemCount = 0;
  await streamFile(deps.drive, folderId, `board-${board.id}.jsonl`, async (writer) => {
    await writer.write(line({ type: 'board', board, schema }));
    for await (const page of deps.monday.boardItemPages(board.id)) {
      // One write per page: memory holds a single page, never the whole board.
      await writer.write(page.map((item) => line({ type: 'item', item })).join(''));
      itemCount += page.length;
    }
  });
  return itemCount;
}

async function backupDoc(deps: BackupDeps, folderId: string, doc: DocSummary): Promise<number> {
  const blocks = await deps.monday.getDocBlocks(doc.id);
  await streamFile(deps.drive, folderId, `doc-${doc.id}.jsonl`, async (writer) => {
    await writer.write(line({ type: 'doc', doc }));
    await writer.write(blocks.map((block) => line({ type: 'block', block })).join(''));
  });
  return blocks.length;
}

export async function runBackup(deps: BackupDeps): Promise<void> {
  const startedAtUtc = deps.now().toISOString();
  const dateFolderName = startedAtUtc.slice(0, 10); // YYYY-MM-DD
  const runId = await deps.runStore.recordRunStart(startedAtUtc);

  // Belt-and-braces alongside the workspace-scoped sandbox token (design doc §4): when set and
  // non-empty, skip anything outside the listed workspace(s). Absent/empty preserves today's
  // "snapshot everything the token can see" behaviour.
  const workspaceIds = deps.config.workspaceIds;
  const inScope = (workspaceId: string | null): boolean =>
    workspaceIds === undefined || workspaceIds.length === 0 || (workspaceId !== null && workspaceIds.includes(workspaceId));

  try {
    const folderId = await deps.drive.ensureDatedFolder(deps.config.destinationParentFolderId, dateFolderName);

    const errors: string[] = [];
    const itemCountsByBoard: Record<string, number> = {};
    const blockCountsByDoc: Record<string, number> = {};
    let boardCount = 0;
    let docCount = 0;

    const boards = await deps.monday.listBoards();
    for (const board of boards) {
      if (deps.config.excludeBoardIds.includes(board.id)) continue;
      if (!inScope(board.workspaceId)) continue;
      try {
        itemCountsByBoard[board.id] = await backupBoard(deps, folderId, board);
        boardCount++;
      } catch (err) {
        const message = errorMessage(err);
        errors.push(`board ${board.id} (${board.name}): ${message}`);
        console.error(`monday-backup: board ${board.id} failed: ${message}`);
      }
    }

    const docs = await deps.monday.listDocs();
    for (const doc of docs) {
      if (!inScope(doc.workspaceId)) continue;
      try {
        blockCountsByDoc[doc.id] = await backupDoc(deps, folderId, doc);
        docCount++;
      } catch (err) {
        const message = errorMessage(err);
        errors.push(`doc ${doc.id} (${doc.name}): ${message}`);
        console.error(`monday-backup: doc ${doc.id} failed: ${message}`);
      }
    }

    // Written last, after every board/doc attempt, so a partial run is obvious from the
    // manifest itself rather than discovered only at restore time (per README's ask).
    await deps.drive.uploadJson(folderId, 'manifest.json', {
      format: SNAPSHOT_FORMAT,
      runAt: startedAtUtc,
      boardCount,
      docCount,
      itemCountsByBoard,
      blockCountsByDoc,
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
