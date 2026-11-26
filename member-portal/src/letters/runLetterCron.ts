import type { MondayClient } from '../monday/client';
import type { LetterSendStore } from '../db/letterSends';
import type { OrgStatementSendStore } from '../db/orgStatementSends';
import type { Config, LetterSendQueueMessage } from '../types';
import { lettersEnabled, letterCronConfigured, orgAccessEnabled } from '../config';
import { triggerLetterSend } from './triggerLetterSend';
import { runOrgStatementPass, type OrgStatementPassResult } from '../orgs/runOrgStatementPass';
import { runDisposition, type WriteMode } from '../flags';
import { stampedQueue } from '../writeSwitch';

export type RunLetterCronResult =
  | {
      kind: 'skipped';
      reason:
        | 'unconfigured'
        // Neither pass can run: the tax letter isn't signed off and organization access is off.
        | 'letters-not-signed-off'
        | 'no-settings'
        | 'auto-send-off'
        | 'before-start-date'
        | 'year-before-history-floor'
        // The write switch is not `on`. The cron only enqueues, so a dry run would show nothing a
        // skip line doesn't, and a row created under `off` would block the donor for good.
        | 'write-switch';
    }
  // A top-level Monday failure (settings read or donations sweep). Reported, never thrown — the
  // daily scheduled() invocation must not reject over a transient outage, and tomorrow's run is
  // the retry.
  | { kind: 'error'; message: string }
  | {
      kind: 'ran';
      year: number;
      // The person pass's counts: all zero while the tax letter isn't signed off.
      eligible: number; // unique donors with a donation dated in `year`
      alreadyHandled: number; // dropped by the letter_sends dedupe pre-check, zero Monday calls
      triggered: number; // sends queued this run
      failed: number; // trigger threw — retried naturally on the next daily run
      deferred: number; // beyond maxTriggersPerRun — picked up by the next daily run
      // The organization pass's counts, present when it ran (orgAccessEnabled).
      orgs?: OrgStatementPassResult;
    };

export interface RunLetterCronDeps {
  monday: MondayClient;
  letterStore: LetterSendStore;
  orgStore: OrgStatementSendStore;
  queue: { send(message: LetterSendQueueMessage): Promise<void> };
  config: Config;
  now: () => Date;
  // The write switch's mode, read once for this run.
  mode: WriteMode;
}

// The automatic January letter-email run, called from the Worker's daily scheduled() handler.
// Staff control it entirely from the Letter Settings board (Auto-send checkbox + start date —
// see scripts/create-letter-settings-board.mjs): the cron checks the board every day and only
// acts once Auto-send is checked and the start date has arrived, so arming, pausing, and timing
// need no deploy. Rerunning daily is deliberate — the letter_sends UNIQUE(donor, year) dedupe
// makes completed donors free, so each run only advances the not-yet-handled remainder
// (self-healing for transient failures and for gifts entered after the first run).
// After the person pass comes the organization pass (src/orgs/runOrgStatementPass.ts): the same
// gates except the tax letter's signoff, and what the person pass left of maxTriggersPerRun.
export async function runLetterCron(deps: RunLetterCronDeps): Promise<RunLetterCronResult> {
  // `dry-run` and `skip` both mean "don't run": no Monday read, no letter_sends row, no message.
  if (runDisposition(deps.mode) !== 'run') {
    return { kind: 'skipped', reason: 'write-switch' };
  }
  try {
    return await runLetterCronInner(deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`member-portal letter cron: run failed (retried tomorrow): ${message}`);
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
  // The person pass needs the tax letter signed off; the organization pass doesn't (the
  // statement's acknowledgment has its own switch). Skip only when neither can run.
  const peopleOn = lettersEnabled(config);
  const orgsOn = orgAccessEnabled(config);
  if (!peopleOn && !orgsOn) {
    return { kind: 'skipped', reason: 'letters-not-signed-off' };
  }

  // Config-only check ahead of any Monday read: with the donation-history floor at or after
  // the first day of the year *following* the target year, every gift the sweep could find is
  // below the floor, so there is nothing to mail. (SVBC: a 2026-01-01 floor means the January
  // 2026 run, which would target 2025, does nothing.) A floor inside the target year falls
  // through — listYearActivity applies it per gift.
  const targetYear = deps.now().getUTCFullYear() - 1;
  const floor = config.donations.historyStartISO;
  if (floor !== null && floor >= `${targetYear + 1}-01-01`) {
    return { kind: 'skipped', reason: 'year-before-history-floor' };
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

  const year = targetYear;
  const activity = await deps.monday.listYearActivity(year, config.taxLetter);
  const eligibleDonorIds = peopleOn ? activity.personIds : [];
  const handled = peopleOn ? await deps.letterStore.listDonorItemIdsForYear(year) : new Set<string>();
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
        taxLetter: config.taxLetter,
        store: deps.letterStore,
        queue: stampedQueue(deps.queue, deps.mode),
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
        `member-portal letter cron: trigger failed for donor "${donorItemId}" (retried tomorrow): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  const orgs = orgsOn
    ? await runOrgStatementPass(
        { monday: deps.monday, store: deps.orgStore, queue: deps.queue, config, now: deps.now, mode: deps.mode },
        year,
        activity.organizationIds,
        config.letterCron.maxTriggersPerRun - batch.length
      )
    : undefined;

  return {
    kind: 'ran',
    year,
    eligible: eligibleDonorIds.length,
    alreadyHandled: eligibleDonorIds.length - pending.length,
    triggered,
    failed,
    deferred: pending.length - batch.length,
    ...(orgs ? { orgs } : {}),
  };
}
