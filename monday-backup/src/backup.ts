import { sendFailureAlert } from './alert';
import type { DriveClient } from './drive/client';
import type { SnapshotRunStore } from './db/runs';
import type { MondayClient } from './monday/client';
import type { BackupConfig } from './types';
import { errorMessage } from './util/errorMessage';

const FAILURE_ALERT_THRESHOLD = 3;

export interface BackupDeps {
  monday: MondayClient;
  drive: DriveClient;
  runStore: SnapshotRunStore;
  config: BackupConfig;
  slackWebhookUrl: string;
  now: () => Date;
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
    let boardCount = 0;
    let docCount = 0;

    const boards = await deps.monday.listBoards();
    for (const board of boards) {
      if (deps.config.excludeBoardIds.includes(board.id)) continue;
      if (!inScope(board.workspaceId)) continue;
      try {
        const schema = await deps.monday.getBoardSchema(board.id);
        const items = await deps.monday.getBoardItems(board.id);
        itemCountsByBoard[board.id] = items.length;
        boardCount++;
        await deps.drive.uploadJson(folderId, `board-${board.id}.json`, { board, schema, items });
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
        const blocks = await deps.monday.getDocBlocks(doc.id);
        docCount++;
        await deps.drive.uploadJson(folderId, `doc-${doc.id}.json`, { doc, blocks });
      } catch (err) {
        const message = errorMessage(err);
        errors.push(`doc ${doc.id} (${doc.name}): ${message}`);
        console.error(`monday-backup: doc ${doc.id} failed: ${message}`);
      }
    }

    // Written last, after every board/doc attempt, so a partial run is obvious from the
    // manifest itself rather than discovered only at restore time (per README's ask).
    await deps.drive.uploadJson(folderId, 'manifest.json', {
      runAt: startedAtUtc,
      boardCount,
      docCount,
      itemCountsByBoard,
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
    // every occurrence, not just after a run-count threshold like the total-failure case below.
    if (errors.length > 0) {
      const detail = errors.length > 5 ? `${errors.slice(0, 5).join('; ')} (+${errors.length - 5} more)` : errors.join('; ');
      await sendFailureAlert(deps.slackWebhookUrl, `partial snapshot — ${errors.length} board/doc(s) failed`, detail);
    }
  } catch (err) {
    const message = errorMessage(err);
    console.error(`monday-backup: run failed: ${message}`);
    const finishedAtUtc = deps.now().toISOString();
    const consecutiveFailures = await deps.runStore.recordRunFailure(runId, finishedAtUtc, message);
    if (consecutiveFailures >= FAILURE_ALERT_THRESHOLD) {
      await sendFailureAlert(deps.slackWebhookUrl, `run failed ${consecutiveFailures} times in a row`, message);
    }
    throw err;
  }
}
