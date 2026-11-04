import { AmbiguousWriteError } from './monday/graphql';
import { LEASE_MS, pageAll, readLoggedActivities, resolveBoards, settleUnsettled, type PassDeps } from './pass';
import { cutoffFor, todayInZone } from './classify';
import { errorText } from './logSafe';

// A logged contact on Activities (Logged) brings someone on Historical back by the next morning, rather
// than at the next quarterly pass. Only logged contact does: a new gift still waits for the pass.
// Runs on days no pass is owed, since a pass reads the same board through src/classify.ts.

export interface LoggedContactReport { planned: number; moved: number; failed: number; ambiguous: number }

const MAX_CONSECUTIVE_FAILURES = 5;

export async function moveLoggedContacts(
  deps: PassDeps, opts: { runId: string; dryRun: boolean },
): Promise<LoggedContactReport | { skipped: string }> {
  const { ledger, config } = deps;
  const now = deps.now ?? (() => new Date());
  const { runId, dryRun } = opts;
  const report: LoggedContactReport = { planned: 0, moved: 0, failed: 0, ambiguous: 0 };
  if (config.loggedActivities === null) return report;

  const startedAt = now().toISOString();
  if (!(await ledger.acquireLease(runId, startedAt, new Date(now().getTime() + LEASE_MS).toISOString()))) {
    return { skipped: `another pass is running; run ${runId} not started` };
  }
  try {
    const { created, existing } = await ledger.startRun({ runId, trigger: 'logged-contact', dryRun, startedAt });
    if (!created) return { skipped: `run ${runId} already recorded (${existing!.status})` };
    try {
      const stopped = await moveAll(deps, opts, report, now);
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
async function moveAll(deps: PassDeps, opts: { runId: string; dryRun: boolean }, report: LoggedContactReport, now: () => Date): Promise<boolean> {
  const { monday, ledger, config } = deps;
  const { runId, dryRun } = opts;
  await settleUnsettled(deps, now);
  const resolved = await resolveBoards(monday, config);
  const todayISO = todayInZone(now(), config.window.timeZone);
  const cutoffISO = cutoffFor(todayISO, config.window.years);

  const latest = new Map<string, string>();
  await readLoggedActivities(monday, config, (personId, dateISO) => {
    if (dateISO > todayISO || dateISO < cutoffISO) return;
    if (dateISO > (latest.get(personId) ?? '')) latest.set(personId, dateISO);
  }, { logged: 0 });

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
