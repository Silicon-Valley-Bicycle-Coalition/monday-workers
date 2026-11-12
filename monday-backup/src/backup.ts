import { sendFailureAlert } from './alert';
import { fileBinding } from './crypto/snapshotCipher';
import { Deadline } from './deadline';
import { SNAPSHOT_FORMAT } from './format';
import type { DriveClient, DriveFileWriter } from './drive/client';
import type { SnapshotRunStore } from './db/runs';
import type { MondayClient } from './monday/client';
import type { RequestStats } from './monday/requestStats';
import type { BackupConfig, BoardSchema, BoardSummary, DocSummary } from './types';
import { errorMessage } from './util/errorMessage';

// Re-exported for existing importers; the layout is documented in ./format.
export { SNAPSHOT_FORMAT };
const JSONL = 'application/x-ndjson';

// A run takes about an hour, far past the 15 minutes a cron invocation gets, so it runs as a
// Workflow (src/workflow.ts): one retried, durable step per board or doc. The logic lives here
// against this small interface so it can be tested with a fake.
//
// Two Workflow rules shape everything below. A step's result is the only state that survives a
// restart, because run() replays from the top with finished steps answering from their saved
// results: so counts and errors are rebuilt from results, never kept anywhere else. And a step can
// run twice, so each one has to be safe to repeat.
export interface SnapshotStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

// Any one call stuck retrying gives up here with a clear BudgetExhaustedError, ahead of the step's
// own 30-minute timeout (src/workflow.ts), which reports only that it timed out. The largest board
// takes about 5.5 minutes.
const STEP_DEADLINE_MS = 25 * 60_000;

// A failing step costs at least 3 minutes of retries. When Drive or Monday is down, trying all 286
// boards and docs would take over 14 hours and tell nobody until the end, so stop and alert instead.
// Rerun by hand once it's fixed: a new run starts its own folder.
const MAX_CONSECUTIVE_FAILURES = 10;

export interface BackupDeps {
  monday: MondayClient;
  drive: DriveClient;
  runStore: SnapshotRunStore;
  config: BackupConfig;
  slackWebhookUrl: string;
  now: () => Date;
  // Shared with the Monday and Drive clients (src/workflow.ts); reset at the start of each step.
  deadline?: Deadline;
  // The write switch, read by each board and doc step so `hold` takes effect within a long run.
  // Absent means on.
  writesOn?: () => Promise<boolean>;
  // Counts the Monday client's requests, for each board's log line.
  requestStats?: RequestStats;
}

const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;

// Writes one file through `produce`, closing it on success and cancelling the upload on failure
// so a half-written board never shows up in Drive looking complete.
async function streamFile(
  drive: DriveClient,
  folderId: string,
  filename: string,
  binding: string,
  produce: (writer: DriveFileWriter) => Promise<void>,
): Promise<void> {
  const writer = await drive.createFile(folderId, filename, JSONL, binding);
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

interface Captured {
  startedAt: string;
  finishedAt: string;
}
interface BoardCounts {
  itemCount: number;
  updateCount: number;
  subitemBoardIds: string[];
}
interface DocCounts {
  blockCount: number;
}
type StepOutcome<T> = { stopped: true } | ({ stopped: false } & Captured & T);

async function backupBoard(deps: BackupDeps, folderId: string, board: BoardSummary, filename: string, binding: string): Promise<BoardCounts> {
  const schema = await deps.monday.getBoardSchema(board.id);
  let itemCount = 0;
  let updateCount = 0;
  await streamFile(deps.drive, folderId, filename, binding, async (writer) => {
    await writer.write(line({ type: 'board', board, schema }));
    for await (const page of deps.monday.boardItemPages(board.id)) {
      // One write per page: memory holds a single page, never the whole board.
      await writer.write(page.map((item) => line({ type: 'item', item })).join(''));
      itemCount += page.length;
    }
    // Updates after items, so a restore has created every item before it replays comments.
    for await (const page of deps.monday.boardUpdatePages(board.id)) {
      await writer.write(page.map((update) => line({ type: 'update', update })).join(''));
      updateCount += page.length;
    }
  });
  return { itemCount, updateCount, subitemBoardIds: subitemBoardIds(schema) };
}

async function backupDoc(deps: BackupDeps, folderId: string, doc: DocSummary, filename: string, binding: string): Promise<DocCounts> {
  let blockCount = 0;
  await streamFile(deps.drive, folderId, filename, binding, async (writer) => {
    await writer.write(line({ type: 'doc', doc }));
    for await (const page of deps.monday.docBlockPages(doc.id)) {
      await writer.write(page.map((block) => line({ type: 'block', block })).join(''));
      blockCount += page.length;
    }
  });
  return { blockCount };
}

// What a finished file holds, for a step repeated after its upload closed.
async function tallyBoardFile(drive: DriveClient, fileId: string, binding: string): Promise<BoardCounts> {
  const counts: BoardCounts = { itemCount: 0, updateCount: 0, subitemBoardIds: [] };
  for await (const text of drive.readLines(fileId, binding)) {
    const record = JSON.parse(text) as { type: string; schema?: BoardSchema };
    if (record.type === 'board' && record.schema !== undefined) counts.subitemBoardIds = subitemBoardIds(record.schema);
    else if (record.type === 'item') counts.itemCount++;
    else if (record.type === 'update') counts.updateCount++;
  }
  return counts;
}

async function tallyDocFile(drive: DriveClient, fileId: string, binding: string): Promise<DocCounts> {
  const counts: DocCounts = { blockCount: 0 };
  for await (const text of drive.readLines(fileId, binding)) {
    if ((JSON.parse(text) as { type: string }).type === 'block') counts.blockCount++;
  }
  return counts;
}

// One board or doc: stop if the switch is off, reuse a file an earlier attempt finished, otherwise
// capture it. Drive allows duplicate names and a Contributor can't delete, so writing again would
// leave a second copy in the snapshot.
async function capture<T extends object>(
  deps: BackupDeps,
  folderId: string,
  filename: string,
  ops: { tally: (fileId: string) => Promise<T>; produce: () => Promise<T>; describe: (counts: T) => string },
): Promise<StepOutcome<T>> {
  if (deps.writesOn !== undefined && !(await deps.writesOn())) return { stopped: true };
  deps.requestStats?.take();
  const existing = await deps.drive.findFile(folderId, filename);
  if (existing !== null) {
    const counts = await ops.tally(existing.id);
    console.log(`monday-backup: ${filename} already uploaded, reused ${ops.describe(counts)}`);
    return { stopped: false, startedAt: existing.createdTime, finishedAt: existing.createdTime, ...counts };
  }
  const startedAt = deps.now();
  const counts = await ops.produce();
  const finishedAt = deps.now();
  // One line per file, with retries, so a slow run can be explained from its logs.
  const { requests, retries } = deps.requestStats?.take() ?? { requests: 0, retries: 0 };
  console.log(
    `monday-backup: ${filename} ${ops.describe(counts)} ms=${finishedAt.getTime() - startedAt.getTime()} requests=${requests} retries=${retries}`,
  );
  return { stopped: false, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), ...counts };
}

// Priority workspaces first, keeping the listed order otherwise.
function prioritized<T extends { workspaceId: string | null }>(entries: T[], workspaces: string[]): T[] {
  const first = (entry: T): boolean => entry.workspaceId !== null && workspaces.includes(entry.workspaceId);
  return [...entries.filter(first), ...entries.filter((entry) => !first(entry))];
}

export async function runSnapshot(step: SnapshotStep, deps: BackupDeps): Promise<void> {
  const deadline = deps.deadline ?? new Deadline();
  // Every step gets its own window, so one slow board can't use up another's.
  const inStep = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
    step.do(name, () => {
      deadline.atMs = deps.now().getTime() + STEP_DEADLINE_MS;
      return fn();
    });

  // Null when the switch isn't on: a skip, with no run row, so the watchdog doesn't count it. The
  // cron has already checked this, but a run can also be triggered by hand.
  const run = await inStep('start', async () => {
    if (deps.writesOn !== undefined && !(await deps.writesOn())) return null;
    const startedAtUtc = deps.now().toISOString();
    return { runId: await deps.runStore.recordRunStart(startedAtUtc), startedAtUtc };
  });
  if (run === null) return;
  const { runId, startedAtUtc } = run;
  // One folder per run, e.g. "2026-08-25 run-17": sorts by date in Drive, and a same-day rerun
  // gets its own folder instead of a second set of same-named files beside the first (#29).
  const snapshotFolder = `${startedAtUtc.slice(0, 10)} run-${runId}`;

  // Belt-and-braces alongside the workspace-scoped sandbox token (design doc §4): when set and
  // non-empty, skip anything outside the listed workspace(s). Absent/empty preserves today's
  // "snapshot everything the token can see" behaviour.
  const workspaceIds = deps.config.workspaceIds;
  const inScope = (workspaceId: string | null): boolean =>
    workspaceIds === undefined || workspaceIds.length === 0 || (workspaceId !== null && workspaceIds.includes(workspaceId));
  const priority = deps.config.priorityWorkspaceIds ?? [];

  try {
    const folderId = await inStep('folder', () => deps.drive.ensureFolder(deps.config.destinationParentFolderId, snapshotFolder));

    const listing = await inStep('list boards', async () => {
      const toCapture: BoardSummary[] = [];
      const deletedBoardsSkipped: string[] = [];
      const leftOut: string[] = [];
      for (const board of await deps.monday.listBoards()) {
        if (deps.config.excludeBoardIds.includes(board.id) || !inScope(board.workspaceId)) leftOut.push(board.id);
        // Deleted boards sit in Monday's own 30-day trash (restorable there); their items can't be
        // paged, so trying would only turn every nightly run partial.
        else if (board.state === 'deleted') deletedBoardsSkipped.push(board.id);
        else toCapture.push(board);
      }
      return { boards: prioritized(toCapture, priority), deletedBoardsSkipped, leftOut };
    });
    const docs = await inStep('list docs', async () =>
      prioritized((await deps.monday.listDocs()).filter((doc) => inScope(doc.workspaceId)), priority),
    );

    const errors: string[] = [];
    const itemCountsByBoard: Record<string, number> = {};
    const updateCountsByBoard: Record<string, number> = {};
    const blockCountsByDoc: Record<string, number> = {};
    const capturedAt: Record<string, Captured> = {};
    let boardCount = 0;
    let docCount = 0;
    let stopped = false;
    let failuresInARow = 0;
    const gaveUp = (): boolean => failuresInARow >= MAX_CONSECUTIVE_FAILURES;
    const giveUpError = `gave up after ${MAX_CONSECUTIVE_FAILURES} failures in a row; the rest of this run was not attempted`;

    const boards = [...listing.boards];
    const queued = new Set([...boards.map((b) => b.id), ...listing.deletedBoardsSkipped, ...listing.leftOut]);

    // The token doesn't list a private board its user isn't subscribed to, so nothing below would
    // ever mention one. This is what makes `success` mean complete.
    const captureIds = new Set(boards.map((b) => b.id));
    for (const id of deps.config.requiredBoardIds ?? []) {
      if (!captureIds.has(id)) errors.push(`board ${id}: required but not visible to this token`);
    }

    // A queue, not a plain loop: backing up a board can discover its subitems board, which is
    // appended if `boards` didn't already list it (issue #30).
    for (let i = 0; i < boards.length && !stopped && !gaveUp(); i++) {
      const board = boards[i]!;
      try {
        const filename = `board-${board.id}.jsonl`;
        const result = await inStep(`board ${board.id}`, () =>
          capture<BoardCounts>(deps, folderId, filename, {
            tally: (fileId) => tallyBoardFile(deps.drive, fileId, fileBinding(snapshotFolder, filename)),
            produce: () => backupBoard(deps, folderId, board, filename, fileBinding(snapshotFolder, filename)),
            describe: (c) => `items=${c.itemCount} updates=${c.updateCount}`,
          }),
        );
        if (result.stopped) {
          stopped = true;
          break;
        }
        itemCountsByBoard[board.id] = result.itemCount;
        updateCountsByBoard[board.id] = result.updateCount;
        capturedAt[`board-${board.id}`] = { startedAt: result.startedAt, finishedAt: result.finishedAt };
        boardCount++;
        failuresInARow = 0;
        for (const subBoardId of result.subitemBoardIds) {
          if (queued.has(subBoardId) || deps.config.excludeBoardIds.includes(subBoardId)) continue;
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
        failuresInARow++;
        console.error(`monday-backup: board ${board.id} failed: ${message}`);
      }
    }

    for (let i = 0; i < docs.length && !stopped && !gaveUp(); i++) {
      const doc = docs[i]!;
      try {
        const filename = `doc-${doc.id}.jsonl`;
        const result = await inStep(`doc ${doc.id}`, () =>
          capture<DocCounts>(deps, folderId, filename, {
            tally: (fileId) => tallyDocFile(deps.drive, fileId, fileBinding(snapshotFolder, filename)),
            produce: () => backupDoc(deps, folderId, doc, filename, fileBinding(snapshotFolder, filename)),
            describe: (c) => `blocks=${c.blockCount}`,
          }),
        );
        if (result.stopped) {
          stopped = true;
          break;
        }
        blockCountsByDoc[doc.id] = result.blockCount;
        capturedAt[`doc-${doc.id}`] = { startedAt: result.startedAt, finishedAt: result.finishedAt };
        docCount++;
        failuresInARow = 0;
      } catch (err) {
        const message = errorMessage(err);
        errors.push(`doc ${doc.id} (${doc.name}): ${message}`);
        failuresInARow++;
        console.error(`monday-backup: doc ${doc.id} failed: ${message}`);
      }
    }

    if (gaveUp()) errors.push(giveUpError);

    // Stopped by the write switch: no manifest, and a folder without one already means "don't use"
    // (RESTORE.md). An operator did this on purpose, so no alert either.
    if (stopped) {
      await inStep('record stop', () =>
        deps.runStore.recordRunStopped(runId, deps.now().toISOString(), 'stopped by the write switch partway through'),
      );
      return;
    }

    // Written last, after every board/doc attempt, so a partial run is obvious from the
    // manifest itself rather than discovered only at restore time (per README's ask).
    const finishedAtUtc = await inStep('manifest', async () => {
      const finishedAt = deps.now().toISOString();
      // A repeat of this step mustn't leave a second manifest.json.
      if ((await deps.drive.findFile(folderId, 'manifest.json')) === null) {
        await deps.drive.uploadJson(folderId, 'manifest.json', {
          format: SNAPSHOT_FORMAT,
          // The scheme and key id the board and doc files need (issue #112); null if unencrypted.
          encryption: deps.drive.encryption === undefined ? null : await deps.drive.encryption(),
          runId,
          snapshotFolder,
          runAt: startedAtUtc,
          // A snapshot is captured board by board over this window, not at one instant (RESTORE.md).
          finishedAt,
          boardCount,
          docCount,
          itemCountsByBoard,
          updateCountsByBoard,
          blockCountsByDoc,
          capturedAt,
          // Every board and doc file this run wrote, by bare name. With the manifest's MAC and each
          // file's run binding, the restore requires exactly these files and no others.
          files: Object.keys(capturedAt).map((name) => `${name}.jsonl`),
          deletedBoardsSkipped: listing.deletedBoardsSkipped,
          errors,
        });
      }
      return finishedAt;
    });

    await inStep('finish', () =>
      deps.runStore.recordRunFinish(runId, finishedAtUtc, {
        status: errors.length === 0 ? 'success' : 'partial',
        boardCount,
        docCount,
        errorCount: errors.length,
        lastError: errors.length > 0 ? (errors[errors.length - 1] ?? null) : null,
      }),
    );

    // A partial snapshot is the failure mode this Worker exists to make visible — alert on
    // every occurrence, same as the total-failure case below.
    if (errors.length > 0) {
      await inStep('alert', async () => {
        const detail = errors.length > 5 ? `${errors.slice(0, 5).join('; ')} (+${errors.length - 5} more)` : errors.join('; ');
        await sendFailureAlert(deps.slackWebhookUrl, `partial snapshot — ${errors.length} board/doc(s) failed`, detail);
      });
    }
  } catch (err) {
    const message = errorMessage(err);
    console.error(`monday-backup: run failed: ${message}`);
    await inStep('record failure', async () => {
      const consecutiveFailures = await deps.runStore.recordRunFailure(runId, deps.now().toISOString(), message);
      // Alert on the first total failure (issue #29): a backup that silently skips up to three
      // nights before anyone hears about it is three nights of unrecoverable edits.
      const streak = consecutiveFailures > 1 ? ` (${consecutiveFailures} nights in a row)` : '';
      await sendFailureAlert(deps.slackWebhookUrl, `run failed — no snapshot was written${streak}`, message);
    });
    throw err;
  }
}
