import { AmbiguousWriteError } from './monday/graphql';
import { ColumnLookupError, columnIdByTitle } from './columns';
import { LEASE_MS, PassAbort, resolveBoards, type PassDeps, type PersonColumnIds, type Resolved } from './pass';
import { todayInZone } from './classify';
import { errorText } from './logSafe';

// Staff promote a person by setting Promote to People = Promote on their item. Unlike the operator's
// move (pass.ts moveOneToPeople) this is the override: there is no liveness check, and the Promoted On
// date it writes is what keeps the person on People for the window. The status stays at Promote until
// the work is done, so a crash anywhere leaves something the morning sweep can find and finish.

export type PromoteSource = 'webhook' | 'sweep';

export type PromoteResult =
  | { outcome: 'moved' | 'promoted-in-place' | 'dry-run' | 'not-requested' | 'not-found' | 'wrong-board' | 'blocked'; itemId: string }
  | { outcome: 'failed' | 'ambiguous' | 'error'; itemId: string; error: string };

const UPDATE_NO_ROOM = "Couldn't promote this person: the People board is full. IT has to make room first. Set Promote again after that.";
const UPDATE_COLUMNS = "Couldn't promote this person: the two People boards don't match, so moves are paused. File an IT Request, then set Promote again.";
const UPDATE_MOVE_FAILED = "Couldn't promote this person: Monday wouldn't move the item, even after retrying. Set Promote again to retry, or file an IT Request if it keeps happening.";

export async function promoteOne(
  deps: PassDeps, resolved: Resolved, opts: { runId: string; itemId: string; dryRun: boolean; source: PromoteSource },
): Promise<PromoteResult> {
  const { itemId } = opts;
  try {
    return await promote(deps, resolved, opts);
  } catch (err) {
    const message = errorText(err);
    console.error(`promote ${opts.runId}: item ${itemId} stopped: ${message}`);
    return { outcome: 'error', itemId, error: message };
  }
}

async function promote(
  deps: PassDeps, resolved: Resolved, opts: { runId: string; itemId: string; dryRun: boolean; source: PromoteSource },
): Promise<PromoteResult> {
  const { monday, ledger, config } = deps;
  const { runId, itemId, dryRun, source } = opts;
  const now = deps.now ?? (() => new Date());

  // Re-read rather than trust the event: a redelivery, or a status staff changed back, stops here.
  const boardId = await monday.getItemBoardId(itemId);
  if (boardId === null) return { outcome: 'not-found', itemId };
  if (boardId !== resolved.live.id && boardId !== resolved.historical.id) return { outcome: 'wrong-board', itemId };
  const onLive = boardId === resolved.live.id;
  const cols = onLive ? resolved.liveCols : resolved.historicalCols;
  const item = await monday.getItemValues(itemId, [cols.promoteStatus]);
  if (item === null) return { outcome: 'not-found', itemId };
  if (item.text.get(cols.promoteStatus) !== config.promote.requestLabel) return { outcome: 'not-requested', itemId };

  const todayISO = todayInZone(now(), config.window.timeZone);
  const promotedOn = { [cols.promotedOn]: { date: todayISO } };
  const done = { [resolved.liveCols.promoteStatus]: { label: config.promote.doneLabel } };

  if (onLive) {
    if (dryRun) return { outcome: 'dry-run', itemId };
    await monday.writeColumnValues(Number(resolved.live.id), itemId, { ...promotedOn, ...done });
    return { outcome: 'promoted-in-place', itemId };
  }

  const historicalId = Number(resolved.historical.id);
  if (resolved.live.itemsCount >= config.thresholds.itemsLimit) {
    if (!dryRun) await reportFailure(deps, historicalId, resolved.historicalCols, itemId, UPDATE_NO_ROOM, runId);
    return { outcome: 'blocked', itemId };
  }

  const row = { runId, itemId, fromBoardId: resolved.historical.id, toBoardId: resolved.live.id, direction: 'to-live' as const, latestActivity: todayISO, reason: 'staff-promoted', plannedAt: now().toISOString() };
  if (dryRun) {
    await ledger.insertMove({ ...row, status: 'dry-run' });
    return { outcome: 'dry-run', itemId };
  }

  await monday.writeColumnValues(historicalId, itemId, promotedOn);
  const id = await ledger.insertMove({ ...row, status: 'planned' });
  try {
    await monday.moveItemToBoard(itemId, Number(resolved.live.id), resolved.liveGroup, resolved.toLive);
  } catch (err) {
    const message = errorText(err);
    // Ambiguous: the item may have moved, so no label; the sweep re-reads its board and finishes.
    const outcome = err instanceof AmbiguousWriteError ? 'ambiguous' : 'failed';
    await ledger.setMoveStatus(id, outcome, now().toISOString(), message);
    console.error(`promote ${runId}: move of item ${itemId} is ${outcome}: ${message}`);
    // The sweep is the last try, so it reports, and clears the date so no pass can later move
    // someone whose label says they failed. A webhook's failure is left for the sweep.
    if (outcome === 'failed' && source === 'sweep') {
      await reportFailure(deps, historicalId, resolved.historicalCols, itemId, UPDATE_MOVE_FAILED, runId, { [resolved.historicalCols.promotedOn]: {} });
    }
    return { outcome, itemId, error: message };
  }
  await ledger.setMoveStatus(id, 'moved', now().toISOString());
  try {
    await monday.writeColumnValues(Number(resolved.live.id), itemId, done);
  } catch (err) {
    // The person is where they should be; the sweep sets the label.
    console.error(`promote ${runId}: item ${itemId} moved, label not set: ${errorText(err)}`);
  }
  console.log(`promote ${runId}: item ${itemId} moved to People`);
  return { outcome: 'moved', itemId };
}

// Best effort: failing to report a failure mustn't hide the outcome.
async function reportFailure(
  deps: PassDeps, boardId: number, cols: Pick<PersonColumnIds, 'promoteStatus'>, itemId: string, update: string, runId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await deps.monday.writeColumnValues(boardId, itemId, { [cols.promoteStatus]: { label: deps.config.promote.failedLabel }, ...extra });
    await deps.monday.postUpdate(itemId, update);
  } catch (err) {
    console.error(`promote ${runId}: couldn't report failure on item ${itemId}: ${errorText(err)}`);
  }
}

// The boards disagree, so there's no Resolved; find the status column from the item's own board.
async function reportColumnsFailure(deps: PassDeps, itemId: string, runId: string): Promise<void> {
  const boardId = await deps.monday.getItemBoardId(itemId);
  const schema = boardId === null ? null : await deps.monday.getBoardSchema(Number(boardId));
  if (schema === null) return;
  const promoteStatus = columnIdByTitle(schema.columns, deps.config.peopleColumns.promoteStatus, `board ${schema.id}`);
  await reportFailure(deps, Number(schema.id), { promoteStatus }, itemId, UPDATE_COLUMNS, runId);
}

export async function promoteFromWebhook(
  deps: PassDeps, opts: { runId: string; itemId: string; dryRun: boolean },
): Promise<PromoteResult | { outcome: 'skipped'; itemId: string }> {
  const now = deps.now ?? (() => new Date());
  const { runId, itemId, dryRun } = opts;
  const startedAt = now().toISOString();
  if (!(await deps.ledger.acquireLease(runId, startedAt, new Date(now().getTime() + LEASE_MS).toISOString()))) {
    return { outcome: 'skipped', itemId };
  }
  try {
    let resolved: Resolved;
    try {
      resolved = await resolveBoards(deps.monday, deps.config);
    } catch (err) {
      const message = errorText(err);
      if (!(err instanceof PassAbort || err instanceof ColumnLookupError)) {
        console.error(`promote ${runId}: item ${itemId} stopped: ${message}`);
        return { outcome: 'error', itemId, error: message };
      }
      console.error(`promote ${runId}: item ${itemId} blocked: ${message}`);
      if (!dryRun) await reportColumnsFailure(deps, itemId, runId).catch((e) => console.error(`promote ${runId}: ${errorText(e)}`));
      return { outcome: 'blocked', itemId };
    }
    const { created } = await deps.ledger.startRun({ runId, trigger: 'single-move', dryRun, startedAt });
    if (!created) return { outcome: 'skipped', itemId };
    const result = await promoteOne(deps, resolved, { runId, itemId, dryRun, source: 'webhook' });
    const failed = result.outcome === 'failed' || result.outcome === 'ambiguous' || result.outcome === 'error';
    await deps.ledger.finishRun(runId, failed ? 'failed' : 'ok', now().toISOString(), result);
    return result;
  } finally {
    await deps.ledger.releaseLease(runId);
  }
}
