import { errorText } from './logSafe';
import { decideCron } from './duties';
import { runPass, type PassDeps } from './pass';
import { sweepPromotes } from './promote';
import { todayInZone } from './classify';

// What the cron does each morning the write switch allows it. The sweep comes first, every day:
// a pass doesn't act on a Promote label, and a capped pass can continue for several days. It holds
// the lease only while it runs, so the pass can start after it.
export async function runDaily(deps: PassDeps, opts: { dryRun: boolean }): Promise<void> {
  const { config, monday, ledger } = deps;
  const now = deps.now ?? (() => new Date());
  const todayISO = todayInZone(now(), config.window.timeZone);

  try {
    const swept = await sweepPromotes(deps, { runId: `${todayISO}-promote-sweep`, dryRun: opts.dryRun });
    if ('skipped' in swept) console.log(`reclassify cron: ${swept.skipped}`);
  } catch (err) {
    console.error(`reclassify cron (promote sweep): ${errorText(err)}`);
  }

  const live = await monday.getBoardSchema(config.boards.live.boardId);
  if (live === null) {
    console.error(`reclassify cron: People board ${config.boards.live.boardId} is not visible — nothing checked`);
    return;
  }
  const decision = decideCron({
    todayISO, liveItemsCount: live.itemsCount, liveItemsLimit: live.itemsLimit ?? config.thresholds.itemsLimit,
    lastRun: await ledger.lastRun({ passesOnly: true }), config,
  });
  if (decision === null) {
    console.log(`reclassify cron: no pass due (People at ${live.itemsCount}/${live.itemsLimit ?? config.thresholds.itemsLimit})`);
    return;
  }
  try {
    const result = await runPass(deps, { ...decision, dryRun: opts.dryRun });
    if ('skipped' in result) console.log(`reclassify cron: ${result.skipped}`);
  } catch (err) {
    console.error(`reclassify cron (${decision.trigger}): ${errorText(err)}`);
  }
}
