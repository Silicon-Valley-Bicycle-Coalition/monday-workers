// The membership duty (spec 2026-10-09 "Nightly duty and the one-time recompute"). Every run
// recomputes the people whose Member Type is due to flip on the 13-month anniversary of their
// Current Term Start, catching up on any nights missed since the last run, and sets Membership
// Status to Lapsed on anyone still Active the day after their Member Until. With all=true it is
// also the post-cutover recompute: load volunteer activity, backfill migrated Term Starts, then
// enqueue every owner with a gift on a membership board plus everyone with a qualifying check-in
// — sliced and cursored across runs like the sweep, continued by the next nightly trigger until
// remaining is 0.
import { addMonths } from '../membership/derive';
import { registrationQualifies, historicalShiftQualifies } from '../membership/volunteer';
import { MondayRateLimitError } from '../monday/client';
import type { CustodianDeps, DutyReport } from './custodian';
import type { OwnerMembershipColumns } from '../types';
import type { DonationRollupsConfig, RecomputeQueueMessage } from '../types';
import type { VolunteerActivityRow } from '../db/volunteerActivity';
import type { HistoricalShiftRecord } from '../monday/client';

export interface MembershipDutyOptions { all: boolean; since: string | null }
export type MembershipPhase = 'anniversaries' | 'load-volunteers' | 'backfill-terms' | 'enqueue';
export interface MembershipDetail {
  all: boolean; since: string | null; phase: MembershipPhase; cursor: string; remaining: number;
  scanned: number; enqueued: number; loaded: number; backfilled: number;
  // Today's UTC date on the run that wrote this detail: the next run's anniversary window
  // starts the day after it. Absent on details stored before it existed.
  anniversariesThroughISO: string;
  // When phases 1–2 finished (the pass moved to enqueue): an owner recomputed after it already
  // saw the loaded check-ins and Term Starts, so phase 3 may skip them. Null until then.
  loadedAtISO: string | null;
}

export const ENQUEUE_PER_RUN = 3_500;   // 35 sendBatch calls of 100, same budget as the sweep
export const BACKFILL_PER_RUN = 5_000;  // 50 items(ids:) reads of 100
// Lapses written per night. A normal night has a handful; the cap only bounds the first run
// after a gap, and the rest are still past due tomorrow.
export const LAPSE_WRITES_PER_RUN = 500;
// Missed nights older than this are not worth re-paging the People boards for.
export const ANNIVERSARY_CATCH_UP_DAYS = 31;
const DAY_MS = 86_400_000;
const isoDay = (t: number): string => new Date(t).toISOString().slice(0, 10);
const TRIGGER_ID = 'custodian:membership';

const ownerMessage = (ownerItemId: string, ownerBoardId: string): RecomputeQueueMessage =>
  ({ donationItemId: TRIGGER_ID, donationBoardId: '', ownerItemId, ownerBoardId });

async function sendAll(deps: CustodianDeps, messages: RecomputeQueueMessage[], opts?: { delaySeconds: number }): Promise<void> {
  for (let i = 0; i < messages.length; i += 100) await deps.queue.sendBatch(messages.slice(i, i + 100), opts);
}

// Exported (config-keyed) for the custodian's shared board read (boardReads.ts, issue GL#90).
export function membershipReadColumns(config: DonationRollupsConfig): { boardId: string; columnIds: string[] }[] {
  if (config.donationRollups.membership === null) return [];
  return membershipBoards({ config }).map((b) => ({ boardId: b.boardId, columnIds: lapseColumns(b.columns) }));
}

// Everything the nightly duty reads from a People board: the anniversary's Current Term Start
// and the lapse check's Status, Tier and Member Until.
const lapseColumns = (c: OwnerMembershipColumns): string[] => [c.currentTermStart, c.status, c.tier, c.until];

function membershipBoards(deps: Pick<CustodianDeps, 'config'>): { boardId: string; currentTermStart: string; columns: OwnerMembershipColumns }[] {
  return Object.entries(deps.config.donationRollups.ownerColumnsByBoard)
    .filter(([, cols]) => cols.membership !== undefined)
    .map(([boardId, cols]) => ({ boardId, currentTermStart: cols.membership!.currentTermStart, columns: cols.membership! }));
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

  // Anniversaries always run first, so an all=true pass that takes several nights doesn't
  // starve them. No earlier run on record: the last two days, as the duty always covered.
  const lastThrough = lastDetail?.anniversariesThroughISO ?? isoDay(now.getTime() - 2 * DAY_MS);
  const anniversaries = withLapses(await runAnniversaries(deps, now, membership.termMonths, lastThrough), await runLapses(deps, now));

  // An unfinished all=true pass is continued by whoever runs next (the nightly cron, or the
  // route again); a fresh all=true starts over at the first phase.
  const continuing = lastDetail !== null && lastDetail.all && lastDetail.remaining > 0;
  if (!opts.all && !continuing) return loadNightlyVolunteers(deps, now, anniversaries);
  const start: MembershipDetail = continuing
    ? { ...lastDetail!, loadedAtISO: lastDetail!.loadedAtISO ?? null }
    : { all: true, since: opts.since, phase: 'load-volunteers', cursor: '', remaining: 1,
      scanned: 0, enqueued: 0, loaded: 0, backfilled: 0, anniversariesThroughISO: '', loadedAtISO: null };
  const all = await runAll(deps, now, start);
  return { ok: all.ok, summary: `${anniversaries.summary}; ${all.summary}`, detail: all.detail };
}

// The nightly share of the Volunteers board: new Eventbrite sign-ups reach volunteer_activity
// here (the board has no webhook), so a Completed row earns credit by the next morning's run
// rather than waiting for an all=true pass.
//
// Order is the guarantee: (1) page and diff every board against D1, writing nothing; (2) enqueue
// the affected owners' recomputes, delayed so the rows are stored before a recompute reads them;
// (3) only then store the rows. A failure at any step leaves rows UNSTORED, so the next night
// diffs them as changed again and re-sends — at-least-once enqueue, never rows stored with
// their owners unsent. The duplicate recompute that can result is harmless: a recompute is a
// full re-derivation from D1 plus a fresh Monday read, writing the same values again.
//
// Bounded like an all=true slice: at most ENQUEUE_PER_RUN owners (and rows) a night, the rest
// left unstored for the next night's diff, so the first run after cutover cannot burst.
export const VOLUNTEER_RECOMPUTE_DELAY_SECONDS = 120;

async function loadNightlyVolunteers(deps: CustodianDeps, now: Date, anniversaries: DutyReport): Promise<DutyReport> {
  const boardsCfg = deps.config.donationRollups.historicalVolunteerBoards;
  if (boardsCfg.length === 0) return anniversaries;
  const failed = (err: unknown): DutyReport => ({ ok: false, detail: anniversaries.detail,
    summary: `${anniversaries.summary}; Volunteers board load failed: ${err instanceof Error ? err.message : String(err)}` });
  const membership = new Set(membershipBoards(deps).map((b) => b.boardId));
  type Change = { boardId: string; s: HistoricalShiftRecord; old: VolunteerActivityRow | undefined; qualifies: boolean };
  const diff: Change[] = [];
  try {
    for (const board of boardsCfg) {
      const known = new Map((await deps.volunteers.forBoard(String(board.boardId))).map((r) => [r.registrationItemId, r]));
      let cursor: string | null = null;
      do {
        const page = await deps.mondayClient.pageHistoricalShifts(board, cursor);
        for (const s of page.items) {
          const old = known.get(s.id);
          const qualifies = historicalShiftQualifies(s, board);
          if (old === undefined || old.qualifies !== qualifies || old.ownerItemId !== s.volunteerItemId
            || old.activityDateISO !== s.dateISO || old.hours !== s.hours) {
            diff.push({ boardId: String(board.boardId), s, old, qualifies });
          }
        }
        cursor = page.cursor;
      } while (cursor !== null);
    }
    if (diff.length === 0) return anniversaries;

    // Tonight's slice: a stable order, as many changes as fit under the owner cap (an owner is
    // someone who counted before or counts now) and the row cap.
    diff.sort((a, b) => (a.boardId + a.s.id < b.boardId + b.s.id ? -1 : 1));
    const slice: Change[] = [];
    const counted = new Set<string>();
    for (const c of diff) {
      const mine = [c.old?.qualifies ? c.old.ownerItemId : null, c.qualifies ? c.s.volunteerItemId : null].filter((x): x is string => x !== null);
      const next = new Set([...counted, ...mine]);
      if (slice.length >= ENQUEUE_PER_RUN || next.size > ENQUEUE_PER_RUN) break;
      slice.push(c);
      for (const id of mine) counted.add(id);
    }
    const remaining = diff.length - slice.length;

    const boardOf = await deps.mondayClient.getItemsBoardIds(slice.flatMap(({ s }) => (s.volunteerItemId ? [s.volunteerItemId] : [])));
    const rows = slice.map(({ boardId, s, qualifies }): VolunteerActivityRow => ({ registrationItemId: s.id, boardId,
      ownerItemId: s.volunteerItemId, ownerBoardId: s.volunteerItemId ? boardOf.get(s.volunteerItemId) ?? null : null,
      activityDateISO: s.dateISO, hours: s.hours, qualifies, source: 'historical' }));
    const targets = new Map<string, string>();   // owner item id -> its board
    for (const [i, row] of rows.entries()) {
      const { old } = slice[i]!;
      // Whoever counted before and whoever counts now — not a row that counted for no one either way.
      if (old?.qualifies && old.ownerItemId !== null && old.ownerBoardId !== null && membership.has(old.ownerBoardId)) targets.set(old.ownerItemId, old.ownerBoardId);
      if (row.qualifies && row.ownerItemId !== null && row.ownerBoardId !== null && membership.has(row.ownerBoardId)) targets.set(row.ownerItemId, row.ownerBoardId);
    }

    await sendAll(deps, [...targets].map(([id, boardId]) => ownerMessage(id, boardId)), { delaySeconds: VOLUNTEER_RECOMPUTE_DELAY_SECONDS });
    await deps.volunteers.upsertMany(rows, now.toISOString());
    return { ok: anniversaries.ok, detail: anniversaries.detail,
      summary: `${anniversaries.summary}; ${rows.length} volunteer row(s) changed, enqueued ${targets.size} owner(s)` +
        (remaining > 0 ? ` — ${remaining} more change(s) remain, continuing next run` : '') };
  } catch (err) {
    return failed(err);
  }
}

// Status on the calendar. A recompute sets Status from Member Until when it runs, but nothing
// runs on the day a term ends: the anniversary recompute lands on Member Until itself (still
// Active), and people with no qualifying activity on Monday (migrated terms only) are never
// recomputed at all. So every night, anyone Active, not Lifetime, whose Member Until is before
// today is set to Lapsed — Status only; Lapse Count and Last Lapsed are derived when the next run
// starts (spec 2026-10-09). The board snapshot can be hours old by the time this runs, so each
// candidate is re-read by id first: a gift recomputed in between must not be lapsed back.
async function runLapses(deps: CustodianDeps, now: Date): Promise<DutyReport> {
  const { statusLabels, tierLabels } = deps.config.donationRollups.membership!;
  const todayISO = isoDay(now.getTime());
  const isDue = (cols: OwnerMembershipColumns, text: (id: string) => string | null): boolean => {
    const until = text(cols.until);
    return text(cols.status) === statusLabels.active && text(cols.tier) !== tierLabels.lifetime
      && until !== null && until.slice(0, 10) < todayISO;
  };

  let due = 0, written = 0;
  const failed: string[] = [];
  for (const board of membershipBoards(deps)) {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await deps.mondayClient.pageItemsColumnsText(Number(board.boardId), lapseColumns(board.columns), cursor);
      for (const item of page.items) if (isDue(board.columns, (c) => item.text.get(c) ?? null)) ids.push(item.id);
      cursor = page.cursor;
    } while (cursor !== null);

    for (let i = 0; i < ids.length; i += 100) {
      const fresh = await deps.mondayClient.getItemsColumnsText(ids.slice(i, i + 100), lapseColumns(board.columns));
      for (const id of ids.slice(i, i + 100)) {
        const cols = fresh.get(id);
        if (cols === undefined || !isDue(board.columns, (c) => cols.get(c) ?? null)) continue;
        due++;
        if (written + failed.length >= LAPSE_WRITES_PER_RUN || deps.writeBudget?.take() === false) continue;
        try {
          await deps.mondayClient.changeColumnValues(Number(board.boardId), id, { [board.columns.status]: { label: statusLabels.lapsed } });
          written++;
        } catch (err) {
          if (err instanceof MondayRateLimitError) throw err;
          failed.push(id);
        }
      }
    }
  }
  const left = due - written - failed.length;
  return { ok: failed.length === 0,
    summary: `lapsed ${written} of ${due} past Member Until` +
      (failed.length > 0 ? ` (failed: ${failed.join(', ')})` : '') + (left > 0 ? ` — ${left} left for the next run` : '') };
}

function withLapses(anniversaries: DutyReport, lapses: DutyReport): DutyReport {
  return { ok: anniversaries.ok && lapses.ok, summary: `${anniversaries.summary}; ${lapses.summary}`, detail: anniversaries.detail };
}

// Everyone whose anniversary — Current Term Start + termMonths — falls after lastThroughISO and
// on or before today, at most ANNIVERSARY_CATCH_UP_DAYS back.
async function runAnniversaries(deps: CustodianDeps, now: Date, termMonths: number, lastThroughISO: string): Promise<DutyReport> {
  const todayISO = isoDay(now.getTime());
  const floorISO = isoDay(now.getTime() - ANNIVERSARY_CATCH_UP_DAYS * DAY_MS);
  const afterISO = lastThroughISO > floorISO ? lastThroughISO : floorISO;
  const messages: RecomputeQueueMessage[] = [];
  let scanned = 0;
  for (const board of membershipBoards(deps)) {
    for (const item of await pageBoard(deps, board.boardId, board.currentTermStart)) {
      scanned++;
      if (item.text === null) continue;
      const anniversary = addMonths(item.text.slice(0, 10), termMonths);
      if (anniversary > afterISO && anniversary <= todayISO) messages.push(ownerMessage(item.id, board.boardId));
    }
  }
  await sendAll(deps, messages);
  const detail: MembershipDetail = { all: false, since: null, phase: 'anniversaries', cursor: '', remaining: 0,
    scanned, enqueued: messages.length, loaded: 0, backfilled: 0, anniversariesThroughISO: todayISO, loadedAtISO: null };
  return { ok: true, summary: `enqueued ${messages.length} anniversary recompute(s) from ${scanned} people`, detail };
}

async function runAll(deps: CustodianDeps, now: Date, detail: MembershipDetail): Promise<DutyReport> {
  const d: MembershipDetail = { ...detail, anniversariesThroughISO: isoDay(now.getTime()) };
  if (d.phase === 'load-volunteers') {
    d.loaded += await loadVolunteers(deps, now);
    d.phase = 'backfill-terms'; d.cursor = '';
  }
  if (d.phase === 'backfill-terms') {
    const r = await backfillTermStarts(deps, now, d.cursor);
    d.backfilled += r.backfilled; d.cursor = r.cursor;
    if (r.remaining > 0) { d.remaining = r.remaining; return done(d); }
    // The moment the load actually finished, not the run's start: phase 1 alone takes minutes,
    // and a recompute in between read part-loaded history. (deps.now pins it in tests.)
    d.phase = 'enqueue'; d.cursor = ''; d.loadedAtISO = (deps.now ?? new Date()).toISOString();
  }
  const r = await enqueueEveryone(deps, d.since, d.loadedAtISO, d.cursor);
  d.enqueued += r.enqueued; d.scanned += r.scanned; d.cursor = r.cursor; d.remaining = r.remaining;
  return done(d);

  function done(detail: MembershipDetail): DutyReport {
    return { ok: true, detail, summary:
      `membership all=true: phase ${detail.phase}, loaded ${detail.loaded} volunteer rows, backfilled ${detail.backfilled} term starts, ` +
      `enqueued ${detail.enqueued} owners` + (detail.remaining > 0 ? ` — ${detail.remaining} remain, continuing next run` : ' — complete') };
  }
}

// Phase 1: the Volunteers board (the 2014-2020 history and new Eventbrite sign-ups), then every
// Event Registrations item of a fork that configures them, into volunteer_activity. Reads only on Monday; upserts are idempotent, so a crash mid-phase is
// simply re-run.
async function loadVolunteers(deps: CustodianDeps, now: Date): Promise<number> {
  const nowISO = now.toISOString();
  let loaded = 0;
  for (const board of deps.config.donationRollups.historicalVolunteerBoards) {
    let cursor: string | null = null;
    do {
      const page = await deps.mondayClient.pageHistoricalShifts(board, cursor);
      const boards = await deps.mondayClient.getItemsBoardIds(page.items.flatMap((s) => (s.volunteerItemId ? [s.volunteerItemId] : [])));
      await deps.volunteers.upsertMany(page.items.map((s) => ({ registrationItemId: s.id, boardId: String(board.boardId),
        ownerItemId: s.volunteerItemId, ownerBoardId: s.volunteerItemId ? boards.get(s.volunteerItemId) ?? null : null,
        activityDateISO: s.dateISO, hours: s.hours, qualifies: historicalShiftQualifies(s, board), source: 'historical' as const })), nowISO);
      loaded += page.items.length;
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
      await deps.volunteers.upsertMany(page.items.map((r) => {
        const start = r.eventItemId === null ? null : eventStart.get(r.eventItemId) ?? null;
        return { registrationItemId: r.id, boardId: String(board.boardId),
          ownerItemId: r.attendeeItemId, ownerBoardId: r.attendeeItemId ? boards.get(r.attendeeItemId) ?? null : null,
          // An archived or deleted registration no longer counts: stored as non-qualifying, so a
          // row an earlier load stored stops counting too.
          activityDateISO: start, hours: r.hours, qualifies: r.state === 'active' && registrationQualifies(r, start, board), source: 'sweep' as const };
      }), nowISO);
      loaded += page.items.length;
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

// Phase 3: one owner-keyed recompute per owner with a live gift on a membership board, plus
// everyone with a qualifying check-in on one — minus owners recomputed after the effective
// instant: the later of `since` (the caller's "already covered") and loadedAtISO (phases 1–2
// done). A recompute before the load finished read incomplete history, so it never counts. A
// never-donor with no check-ins is not recomputed: there is nothing to derive. Owner-id cursor,
// not a Monday page cursor, so the slice survives across nights.
async function enqueueEveryone(
  deps: CustodianDeps, since: string | null, loadedAtISO: string | null, cursorIn: string,
): Promise<{ enqueued: number; scanned: number; cursor: string; remaining: number }> {
  const boards = new Set(membershipBoards(deps).map((b) => b.boardId));
  const owners = new Map<string, string>();
  for (const o of await deps.gifts.ownersOnBoards([...boards])) owners.set(o.ownerItemId, o.ownerBoardId);
  let after = '';
  for (;;) {
    const batch = await deps.volunteers.ownersWithActivity(after, 1000);
    for (const o of batch) {
      // A check-in owner on a board with no membership columns (or none resolved) has nothing
      // to recompute — enqueueing one would only DLQ on the missing owner columns.
      if (!owners.has(o.ownerItemId) && o.ownerBoardId !== null && boards.has(o.ownerBoardId)) owners.set(o.ownerItemId, o.ownerBoardId);
    }
    if (batch.length < 1000) break;
    after = batch.at(-1)!.ownerItemId;
  }
  const effective = since === null ? loadedAtISO : (loadedAtISO === null || since > loadedAtISO ? since : loadedAtISO);
  const covered = effective === null ? new Set<string>() : await deps.recomputes.writtenSince(effective);
  const todo = [...owners.keys()].filter((id) => id > cursorIn && !covered.has(id)).sort();
  const slice = todo.slice(0, ENQUEUE_PER_RUN);
  await sendAll(deps, slice.map((id) => ownerMessage(id, owners.get(id)!)));
  return { enqueued: slice.length, scanned: owners.size, cursor: slice.at(-1) ?? cursorIn, remaining: todo.length - slice.length };
}
