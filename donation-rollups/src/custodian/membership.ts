// The membership duty (spec 2026-10-09 "Nightly duty and the one-time recompute"). Nightly it
// recomputes the people whose Member Type is due to flip on the 13-month anniversary of their
// Current Term Start. With all=true it is the post-cutover recompute: load volunteer activity,
// backfill migrated Term Starts, then enqueue every person once — sliced and cursored across
// runs like the sweep, continued by the next nightly trigger until remaining is 0.
import { addMonths } from '../membership/derive';
import { registrationQualifies, historicalShiftQualifies } from '../membership/volunteer';
import type { CustodianDeps, DutyReport } from './custodian';
import type { RecomputeQueueMessage } from '../types';

export interface MembershipDutyOptions { all: boolean; since: string | null }
export type MembershipPhase = 'anniversaries' | 'load-volunteers' | 'backfill-terms' | 'enqueue';
export interface MembershipDetail {
  all: boolean; since: string | null; phase: MembershipPhase; cursor: string; remaining: number;
  scanned: number; enqueued: number; loaded: number; backfilled: number;
}

export const ENQUEUE_PER_RUN = 3_500;   // 35 sendBatch calls of 100, same budget as the sweep
export const BACKFILL_PER_RUN = 5_000;  // 50 items(ids:) reads of 100
const TRIGGER_ID = 'custodian:membership';

const ownerMessage = (ownerItemId: string, ownerBoardId: string): RecomputeQueueMessage =>
  ({ donationItemId: TRIGGER_ID, donationBoardId: '', ownerItemId, ownerBoardId });

async function sendAll(deps: CustodianDeps, messages: RecomputeQueueMessage[]): Promise<void> {
  for (let i = 0; i < messages.length; i += 100) await deps.queue.sendBatch(messages.slice(i, i + 100));
}

function membershipBoards(deps: CustodianDeps): { boardId: string; currentTermStart: string }[] {
  return Object.entries(deps.config.donationRollups.ownerColumnsByBoard)
    .filter(([, cols]) => cols.membership !== undefined)
    .map(([boardId, cols]) => ({ boardId, currentTermStart: cols.membership!.currentTermStart }));
}

// Every item on a People board, with one column's text — paged in full each run (reads are
// cheap; Monday page cursors expire, so nothing here persists one across runs).
async function pageBoard(deps: CustodianDeps, boardId: string, columnId: string): Promise<{ id: string; text: string | null }[]> {
  const out: { id: string; text: string | null }[] = [];
  let cursor: string | null = null;
  do {
    const page = await deps.mondayClient.pageItemsColumnsText(Number(boardId), [columnId], cursor);
    for (const item of page.items) out.push({ id: item.id, text: item.text.get(columnId) ?? null });
    cursor = page.cursor;
  } while (cursor !== null);
  return out;
}

export async function runMembership(
  deps: CustodianDeps, now: Date, opts: MembershipDutyOptions, lastDetail: MembershipDetail | null,
): Promise<DutyReport> {
  const membership = deps.config.donationRollups.membership;
  if (membership === null) return { ok: true, summary: 'membership block is null — nothing to do', detail: null };

  // An unfinished all=true pass is continued by whoever runs next (the nightly cron, or the
  // route again); a fresh all=true starts over at the first phase.
  const continuing = lastDetail !== null && lastDetail.all && lastDetail.remaining > 0;
  if (opts.all || continuing) {
    const start: MembershipDetail = continuing ? lastDetail! : { all: true, since: opts.since, phase: 'load-volunteers', cursor: '', remaining: 1,
      scanned: 0, enqueued: 0, loaded: 0, backfilled: 0 };
    return runAll(deps, now, start);
  }
  return runAnniversaries(deps, now, membership.termMonths);
}

async function runAnniversaries(deps: CustodianDeps, now: Date, termMonths: number): Promise<DutyReport> {
  const todayISO = now.toISOString().slice(0, 10);
  const yesterdayISO = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const messages: RecomputeQueueMessage[] = [];
  let scanned = 0;
  for (const board of membershipBoards(deps)) {
    for (const item of await pageBoard(deps, board.boardId, board.currentTermStart)) {
      scanned++;
      if (item.text === null) continue;
      const anniversary = addMonths(item.text.slice(0, 10), termMonths);
      if (anniversary === todayISO || anniversary === yesterdayISO) messages.push(ownerMessage(item.id, board.boardId));
    }
  }
  await sendAll(deps, messages);
  const detail: MembershipDetail = { all: false, since: null, phase: 'anniversaries', cursor: '', remaining: 0,
    scanned, enqueued: messages.length, loaded: 0, backfilled: 0 };
  return { ok: true, summary: `enqueued ${messages.length} anniversary recompute(s) from ${scanned} people`, detail };
}

// Task 11 fills this in.
async function runAll(deps: CustodianDeps, now: Date, detail: MembershipDetail): Promise<DutyReport> {
  return { ok: false, summary: 'membership all=true is not implemented yet', detail };
}
