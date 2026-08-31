import type { MondayClient } from '../monday/client';
import type { LetterSendStore } from '../db/letterSends';
import type { Config, LetterSendQueueMessage } from '../types';
import { lettersEnabled, letterCronConfigured } from '../config';
import { triggerLetterSend } from './triggerLetterSend';

export type RunLetterCronResult =
  | {
      kind: 'skipped';
      reason: 'unconfigured' | 'letters-not-signed-off' | 'no-settings' | 'auto-send-off' | 'before-start-date';
    }
  // A top-level Monday failure (settings read or donations sweep). Reported, never thrown — the
  // daily scheduled() invocation must not reject over a transient outage, and tomorrow's run is
  // the retry.
  | { kind: 'error'; message: string }
  | {
      kind: 'ran';
      year: number;
      eligible: number; // unique donors with a donation dated in `year`
      alreadyHandled: number; // dropped by the letter_sends dedupe pre-check, zero Monday calls
      triggered: number; // sends queued this run
      failed: number; // trigger threw — retried naturally on the next daily run
      deferred: number; // beyond maxTriggersPerRun — picked up by the next daily run
    };

export interface RunLetterCronDeps {
  monday: MondayClient;
  letterStore: LetterSendStore;
  queue: { send(message: LetterSendQueueMessage): Promise<void> };
  config: Config;
  now: () => Date;
}

// The automatic January letter-email run, called from the Worker's daily scheduled() handler.
// Staff control it entirely from the Letter Settings board (Auto-send checkbox + start date —
// see scripts/create-letter-settings-board.mjs): the cron checks the board every day and only
// acts once Auto-send is checked and the start date has arrived, so arming, pausing, and timing
// need no deploy. Rerunning daily is deliberate — the letter_sends UNIQUE(donor, year) dedupe
// makes completed donors free, so each run only advances the not-yet-handled remainder
// (self-healing for transient failures and for gifts entered after the first run).
export async function runLetterCron(deps: RunLetterCronDeps): Promise<RunLetterCronResult> {
  try {
    return await runLetterCronInner(deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`donor-portal letter cron: run failed (retried tomorrow): ${message}`);
    return { kind: 'error', message };
  }
}

async function runLetterCronInner(deps: RunLetterCronDeps): Promise<RunLetterCronResult> {
  const { config } = deps;
  // donationsBoardId backs the eligibility sweep, so treat it as part of "configured" — without
  // the check, a filled-in letterCron over an unset board id would sweep board 0.
  if (!letterCronConfigured(config) || config.letterCron.boardId === null || config.monday.donationsBoardId === null) {
    return { kind: 'skipped', reason: 'unconfigured' };
  }
  if (!lettersEnabled(config)) {
    return { kind: 'skipped', reason: 'letters-not-signed-off' };
  }

  const settings = await deps.monday.getLetterSettings({
    boardId: config.letterCron.boardId,
    columns: config.letterCron.columns,
    settingsItemName: config.letterCron.settingsItemName,
  });
  if (settings === null) {
    return { kind: 'skipped', reason: 'no-settings' };
  }
  if (!settings.autoSend) {
    return { kind: 'skipped', reason: 'auto-send-off' };
  }
  const today = deps.now().toISOString().slice(0, 10);
  // Lexicographic compare is calendar compare for YYYY-MM-DD strings. An empty startDate means
  // staff haven't picked one yet — treat as "not yet", never as "immediately".
  if (settings.startDate === '' || today < settings.startDate) {
    return { kind: 'skipped', reason: 'before-start-date' };
  }

  const year = deps.now().getUTCFullYear() - 1;
  const eligibleDonorIds = await deps.monday.listDonorIdsWithDonationsInYear(year);
  const handled = await deps.letterStore.listDonorItemIdsForYear(year);
  const pending = eligibleDonorIds.filter((id) => !handled.has(id));
  const batch = pending.slice(0, config.letterCron.maxTriggersPerRun);

  let triggered = 0;
  let failed = 0;
  // Sequential on purpose: same Monday complexity-budget reasoning as the queue consumers'
  // max_concurrency: 1 in wrangler.jsonc.
  for (const donorItemId of batch) {
    try {
      const result = await triggerLetterSend(donorItemId, {
        monday: deps.monday,
        store: deps.letterStore,
        queue: deps.queue,
        now: deps.now,
      });
      if (result.kind === 'queued') {
        triggered++;
      }
      // 'duplicate' / 'no-eligible-year' are fine: either a concurrent button click got there
      // first, or the donor's gifts changed since the sweep. Nothing to retry.
    } catch (err) {
      failed++;
      console.error(
        `donor-portal letter cron: trigger failed for donor "${donorItemId}" (retried tomorrow): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return {
    kind: 'ran',
    year,
    eligible: eligibleDonorIds.length,
    alreadyHandled: eligibleDonorIds.length - pending.length,
    triggered,
    failed,
    deferred: pending.length - batch.length,
  };
}
