import { AmbiguousWriteError } from './monday/graphql';
import { LEASE_MS, pageAll, readLoggedActivities, resolveBoards, settleUnsettled, type PassDeps } from './pass';
import { cutoffFor, todayInZone } from './classify';
import { errorText } from './logSafe';
import type { RunRow } from './db/ledger';

// A logged contact on Activities (Logged) brings someone on Historical back by the next morning, rather
// than at the next quarterly pass. Only logged contact does: a new gift still waits for the pass.
// Runs on days no pass is owed, since a pass reads the same board through src/classify.ts.

// deferred: people due a move that the per-run cap or People's room left for a later run.
export interface LoggedContactReport { planned: number; moved: number; failed: number; ambiguous: number; deferred: number }

const MAX_CONSECUTIVE_FAILURES = 5;

// How far before the last clean run a daily run starts reading Activities (Logged) (#101). Covers
// an activity logged a little after the date it's dated (a call written up the next week) and the
// time-zone edge of Monday's date rule. Anything dated earlier than this but logged since waits for
// the next quarterly or threshold pass, which reads the whole window.
export const LOOKBACK_MARGIN_DAYS = 14;

// The first date a daily run reads Activities (Logged) from. A quiet day shouldn't page the whole
// board (nor People (Historical) after it), so it starts shortly before the last live run that left
// nothing behind: it finished ok and every person it found due was moved. Anything else, including
// no such run or a summary from before deferred was counted, reads the whole window again.
export function loggedReadSince(previous: RunRow | null, cutoffISO: string, timeZone: string): string {
  if (previous === null || previous.dryRun || previous.status !== 'ok') return cutoffISO;
  const s = previous.summary as Partial<LoggedContactReport> | null;
  if (s === null || s.failed !== 0 || s.ambiguous !== 0 || s.deferred !== 0) return cutoffISO;
  const [y, m, d] = todayInZone(new Date(previous.startedAt), timeZone).split('-').map(Number) as [number, number, number];
  const since = new Date(Date.UTC(y, m - 1, d - LOOKBACK_MARGIN_DAYS)).toISOString().slice(0, 10);
  return since > cutoffISO ? since : cutoffISO;
}

export async function moveLoggedContacts(
  deps: PassDeps, opts: { runId: string; dryRun: boolean },
): Promise<LoggedContactReport | { skipped: string }> {
  const { ledger, config } = deps;
  const now = deps.now ?? (() => new Date());
  const { runId, dryRun } = opts;
  const report: LoggedContactReport = { planned: 0, moved: 0, failed: 0, ambiguous: 0, deferred: 0 };
  if (config.loggedActivities === null) return report;

  const startedAt = now().toISOString();
  if (!(await ledger.acquireLease(runId, startedAt, new Date(now().getTime() + LEASE_MS).toISOString()))) {
    return { skipped: `another pass is running; run ${runId} not started` };
  }
  try {
    // Read before startRun, which would make this run the latest.
    const previous = await ledger.lastRun({ trigger: 'logged-contact', dryRun: false });
    const { created, existing } = await ledger.startRun({ runId, trigger: 'logged-contact', dryRun, startedAt });
    if (!created) return { skipped: `run ${runId} already recorded (${existing!.status})` };
    try {
      const stopped = await moveAll(deps, opts, report, now, previous);
      await ledger.finishRun(runId, stopped ? 'failed' : 'ok', now().toISOString(), report);
      console.log(`reclassify ${runId}${dryRun ? ' (dry run)' : ''}: planned ${report.planned}, moved ${report.moved}, failed ${report.failed}, ambiguous ${report.ambiguous}`);
      return report;
    } catch (err) {
      const message = errorText(err);
      console.error(`reclassify ${runId}: logged-contact run failed: ${message}`);
      await ledger.finishRun(runId, 'failed', now().toISOString(), { error: message });
      throw err;
    }
  } finally {
    await ledger.releaseLease(runId);
  }
}

// Returns whether it stopped early on consecutive failures.
async function moveAll(
  deps: PassDeps, opts: { runId: string; dryRun: boolean }, report: LoggedContactReport, now: () => Date, previous: RunRow | null,
): Promise<boolean> {
  const { monday, ledger, config } = deps;
  const { runId, dryRun } = opts;
  await settleUnsettled(deps, now);
  const resolved = await resolveBoards(monday, config);
  const todayISO = todayInZone(now(), config.window.timeZone);
  const cutoffISO = cutoffFor(todayISO, config.window.years);
  const sinceISO = loggedReadSince(previous, cutoffISO, config.window.timeZone);

  const latest = new Map<string, string>();
  await readLoggedActivities(monday, config, (personId, dateISO) => {
    if (dateISO > todayISO || dateISO < sinceISO) return;
    if (dateISO > (latest.get(personId) ?? '')) latest.set(personId, dateISO);
  }, { logged: 0 }, sinceISO);

  const due: { itemId: string; latestActivity: string }[] = [];
  if (latest.size > 0) {
    for await (const item of pageAll(monday, Number(resolved.historical.id), [resolved.historicalCols.promotedOn])) {
      const latestActivity = latest.get(item.id);
      if (latestActivity !== undefined) due.push({ itemId: item.id, latestActivity });
    }
  }
  due.sort((a, b) => b.latestActivity.localeCompare(a.latestActivity));
  const room = Math.max(0, config.thresholds.itemsLimit - resolved.live.itemsCount);
  const plan = due.slice(0, Math.min(config.run.maxMovesPerRun, room));
  report.planned = plan.length;
  report.deferred = due.length - plan.length;

  let consecutiveFailures = 0;
  for (const { itemId, latestActivity } of plan) {
    const id = await ledger.insertMove({
      runId, itemId, fromBoardId: resolved.historical.id, toBoardId: resolved.live.id, direction: 'to-live',
      latestActivity, reason: 'logged-contact', status: dryRun ? 'dry-run' : 'planned', plannedAt: now().toISOString(),
    });
    if (dryRun) continue;
    try {
      await monday.moveItemToBoard(itemId, Number(resolved.live.id), resolved.liveGroup, resolved.toLive);
      await ledger.setMoveStatus(id, 'moved', now().toISOString());
      report.moved += 1;
      consecutiveFailures = 0;
    } catch (err) {
      const message = errorText(err);
      const outcome = err instanceof AmbiguousWriteError ? 'ambiguous' : 'failed';
      report[outcome] += 1;
      await ledger.setMoveStatus(id, outcome, now().toISOString(), message);
      console.error(`reclassify ${runId}: move of item ${itemId} to-live is ${outcome}: ${message}`);
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return true;
    }
  }
  return false;
}
