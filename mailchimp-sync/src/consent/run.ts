// The hourly consent sync (spec docs/superpowers/specs/2026-11-16-mailchimp-consent-columns-
// design.md): read every Mailchimp member's status, read each configured board's address and
// consent columns, and write only the consent values that differ. Stateless: a failed run, board
// or item is simply redone the next hour, so there is no cursor.
//
// Logs carry board names, column and item ids and counts only; never an address or a name.
import { runDisposition, type WriteMode } from '../flags';
import { dryRunConsentMonday, type BatchSkipContext } from '../writeSwitch';
import type { Config } from '../types';
import { applyGuard, planBoard, summarize, toWrites, type ConsentChange } from './plan';
import { ConsentShortReadError, type ConsentMonday } from './sources';

export const CONSENT_CRON = '5 * * * *';

export interface ConsentRunDeps {
  config: Config;
  monday: ConsentMonday;
  readStatuses: () => Promise<Map<string, string>>;
  alert: (text: string) => Promise<void>;
}

export interface ConsentRunSummary {
  outcome: 'disabled' | 'skipped' | 'short-read' | 'done';
  mode: WriteMode;
  // Items read, by board name.
  items: Record<string, number>;
  // Changes planned (written, dry-run or held), by board, column and transition.
  transitions: Record<string, number>;
  // Sendable changes held by the cap.
  held: number;
  written: number;
  failed: number;
  // Boards whose read failed; the others still ran.
  failedBoards: string[];
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : 'UnknownError');

export async function runConsentSync(gate: BatchSkipContext, deps: ConsentRunDeps): Promise<ConsentRunSummary> {
  const { config } = deps;
  const summary: ConsentRunSummary = { outcome: 'done', mode: gate.mode, items: {}, transitions: {}, held: 0, written: 0, failed: 0, failedBoards: [] };
  const prefix = `mailchimp-sync consent (${gate.environment}):`;

  if (!config.consent.enabled) {
    console.log('mailchimp-sync consent: consent.enabled is false; skipping');
    return { ...summary, outcome: 'disabled' };
  }
  const disposition = runDisposition(gate.mode);
  if (disposition === 'skip') {
    console.warn(`mailchimp-sync consent: write mode is "${gate.mode}"; skipping the consent run`);
    return { ...summary, outcome: 'skipped' };
  }

  let statuses: Map<string, string>;
  try {
    statuses = await deps.readStatuses();
  } catch (err) {
    if (!(err instanceof ConsentShortReadError)) throw err;
    // A member missing from the read would plan as "Not in Mailchimp"; write nothing at all.
    const text = `${prefix} the Mailchimp read came back short (${err.message}); nothing written this run`;
    console.error(text);
    await deps.alert(text);
    return { ...summary, outcome: 'short-read' };
  }

  const changes: ConsentChange[] = [];
  for (const board of config.consent.boards) {
    try {
      const items = await deps.monday.readBoard(board);
      summary.items[board.name] = items.length;
      changes.push(...planBoard(board, items, statuses));
    } catch (err) {
      summary.failedBoards.push(board.name);
      console.error(JSON.stringify({ worker: 'mailchimp-sync', event: 'consent-board-failed', environment: gate.environment, board: board.name, boardId: board.boardId, error: errName(err) }));
    }
  }
  summary.transitions = summarize(changes);

  const { allowed, held, tripped } = applyGuard(changes, config.consent.maxChangesPerRun);
  summary.held = held.length;
  if (tripped) {
    const text = `${prefix} ${held.length} changes toward a sendable value exceed consent.maxChangesPerRun (${config.consent.maxChangesPerRun}); held them and wrote only the ${allowed.length} opt-outs. Transitions: ${JSON.stringify(summarize(held))}`;
    console.error(text);
    await deps.alert(text);
  }

  const monday = disposition === 'dry-run' ? dryRunConsentMonday(deps.monday, { ...gate, deliveryId: 'consent-cron' }) : deps.monday;
  const writes = toWrites(allowed);
  if (writes.length > 0) {
    const result = await monday.writeConsent(writes);
    summary.written = result.written;
    summary.failed = result.failedItemIds.length;
    if (result.failedItemIds.length > 0) {
      console.error(JSON.stringify({ worker: 'mailchimp-sync', event: 'consent-writes-failed', environment: gate.environment, itemIds: result.failedItemIds }));
    }
  }

  console.log(JSON.stringify({ worker: 'mailchimp-sync', event: 'consent-run', environment: gate.environment, ...summary }));
  return summary;
}
