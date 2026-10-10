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

async function runAll(deps: CustodianDeps, now: Date, detail: MembershipDetail): Promise<DutyReport> {
  const d = { ...detail };
  if (d.phase === 'load-volunteers') {
    d.loaded += await loadVolunteers(deps, now);
    d.phase = 'backfill-terms'; d.cursor = '';
  }
  if (d.phase === 'backfill-terms') {
    const r = await backfillTermStarts(deps, now, d.cursor);
    d.backfilled += r.backfilled; d.cursor = r.cursor;
    if (r.remaining > 0) { d.remaining = r.remaining; return done(d); }
    d.phase = 'enqueue'; d.cursor = '';
  }
  const r = await enqueueEveryone(deps, d.since, d.cursor);
  d.enqueued += r.enqueued; d.scanned += r.scanned; d.cursor = r.cursor; d.remaining = r.remaining;
  return done(d);

  function done(detail: MembershipDetail): DutyReport {
    return { ok: true, detail, summary:
      `membership all=true: phase ${detail.phase}, loaded ${detail.loaded} volunteer rows, backfilled ${detail.backfilled} term starts, ` +
      `enqueued ${detail.enqueued} owners` + (detail.remaining > 0 ? ` — ${detail.remaining} remain, continuing next run` : ' — complete') };
  }
}

// Phase 1: the 2014-2020 Volunteers board, then every Event Registrations item, into
// volunteer_activity. Reads only on Monday; upserts are idempotent, so a crash mid-phase is
// simply re-run.
async function loadVolunteers(deps: CustodianDeps, now: Date): Promise<number> {
  const nowISO = now.toISOString();
  let loaded = 0;
  for (const board of deps.config.donationRollups.historicalVolunteerBoards) {
    let cursor: string | null = null;
    do {
      const page = await deps.mondayClient.pageHistoricalShifts(board, cursor);
      const boards = await deps.mondayClient.getItemsBoardIds(page.items.flatMap((s) => (s.volunteerItemId ? [s.volunteerItemId] : [])));
      for (const s of page.items) {
        await deps.volunteers.upsert({ registrationItemId: s.id, boardId: String(board.boardId),
          ownerItemId: s.volunteerItemId, ownerBoardId: s.volunteerItemId ? boards.get(s.volunteerItemId) ?? null : null,
          activityDateISO: s.dateISO, hours: s.hours, qualifies: historicalShiftQualifies(s, board), source: 'historical' }, nowISO);
        loaded++;
      }
      cursor = page.cursor;
    } while (cursor !== null);
  }
  for (const board of deps.config.donationRollups.volunteerBoards) {
    const eventStart = new Map((await pageBoard(deps, String(board.eventBoard.boardId), board.eventBoard.columns.start))
      .map((e) => [e.id, e.text === null ? null : e.text.slice(0, 10)]));
    let cursor: string | null = null;
    do {
      const page = await deps.mondayClient.pageRegistrations(board, cursor);
      const boards = await deps.mondayClient.getItemsBoardIds(page.items.flatMap((r) => (r.attendeeItemId ? [r.attendeeItemId] : [])));
      for (const r of page.items) {
        const start = r.eventItemId === null ? null : eventStart.get(r.eventItemId) ?? null;
        await deps.volunteers.upsert({ registrationItemId: r.id, boardId: String(board.boardId),
          ownerItemId: r.attendeeItemId, ownerBoardId: r.attendeeItemId ? boards.get(r.attendeeItemId) ?? null : null,
          activityDateISO: start, hours: r.hours, qualifies: registrationQualifies(r, start, board), source: 'sweep' }, nowISO);
        loaded++;
      }
      cursor = page.cursor;
    } while (cursor !== null);
  }
  return loaded;
}

// Phase 2: migrated Term Starts for pre-cutover gifts the webhook path never reads (archived
// ones above all). items(ids:) returns archived items; an item Monday no longer returns is
// recorded as '' so it is never asked for again.
async function backfillTermStarts(deps: CustodianDeps, now: Date, cursorIn: string): Promise<{ backfilled: number; cursor: string; remaining: number }> {
  const { fromISO } = deps.config.donationRollups.membership!;
  const termColumns = deps.config.donationRollups.donationBoards.flatMap((b) => (b.columns.termStart ? [b.columns.termStart] : []));
  let cursor = cursorIn;
  let backfilled = 0;
  while (backfilled < BACKFILL_PER_RUN) {
    const ids = await deps.gifts.giftsMissingTermStart(fromISO, cursor, Math.min(500, BACKFILL_PER_RUN - backfilled));
    if (ids.length === 0) return { backfilled, cursor, remaining: 0 };
    const text = await deps.mondayClient.getItemsColumnsText(ids, termColumns);
    await deps.gifts.setTermStarts(ids.map((id) => {
      const cols = text.get(id);
      const value = termColumns.map((c) => cols?.get(c) ?? null).find((v) => v !== null) ?? null;
      return { mondayItemId: id, termStart: value === null ? '' : value.slice(0, 10) };
    }), now.toISOString());
    backfilled += ids.length;
    cursor = ids.at(-1)!;
  }
  const more = await deps.gifts.giftsMissingTermStart(fromISO, cursor, 1);
  return { backfilled, cursor, remaining: more.length };
}

// Phase 3: one owner-keyed recompute per person — every item on a membership board, plus
// anyone with a qualifying check-in who is somehow not on one — minus people a recompute
// already covered since `since` (the runbook runs the sweep first). Owner-id cursor, not a
// Monday page cursor, so the slice survives across nights.
async function enqueueEveryone(deps: CustodianDeps, since: string | null, cursorIn: string): Promise<{ enqueued: number; scanned: number; cursor: string; remaining: number }> {
  const owners = new Map<string, string>();
  for (const board of membershipBoards(deps)) {
    for (const item of await pageBoard(deps, board.boardId, board.currentTermStart)) owners.set(item.id, board.boardId);
  }
  let after = '';
  for (;;) {
    const batch = await deps.volunteers.ownersWithActivity(after, 1000);
    for (const o of batch) if (!owners.has(o.ownerItemId) && o.ownerBoardId !== '') owners.set(o.ownerItemId, o.ownerBoardId);
    if (batch.length < 1000) break;
    after = batch.at(-1)!.ownerItemId;
  }
  const covered = since === null ? new Set<string>() : await deps.recomputes.writtenSince(since);
  const todo = [...owners.keys()].filter((id) => id > cursorIn && !covered.has(id)).sort();
  const slice = todo.slice(0, ENQUEUE_PER_RUN);
  await sendAll(deps, slice.map((id) => ownerMessage(id, owners.get(id)!)));
  return { enqueued: slice.length, scanned: owners.size, cursor: slice.at(-1) ?? cursorIn, remaining: todo.length - slice.length };
}
