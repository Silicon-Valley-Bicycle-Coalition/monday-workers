import { AmbiguousWriteError } from './monday/graphql';
import type { ReclassificationMondayClient, BoardSchema, PageFilter, PageItem } from './monday/client';
import { columnIdByTitle, moveMapping, type ColumnMapping } from './columns';
import { classify, cutoffFor, dateOnly, todayInZone, type Board, type PersonFacts, type Verdict } from './classify';
import type { Direction, Ledger, RunTrigger } from './db/ledger';
import { errorText } from './logSafe';
import type { ReclassificationConfig } from './types';

// One reclassification pass: read both People boards and the activity sources, decide each
// person with src/classify.ts, move what the window says to move (unless dry run), and record
// all of it in the D1 ledger. Reads before writes; writes one item at a time, each confirmed
// before its ledger row says 'moved'.

export interface PassDeps {
  monday: ReclassificationMondayClient;
  ledger: Ledger;
  config: ReclassificationConfig;
  now?: () => Date;
}

export interface PassOptions { runId: string; trigger: RunTrigger; dryRun: boolean }

export interface BoardCount { boardId: string; name: string; itemsCount: number; itemsLimit: number; pct: number }

export interface PassReport {
  runId: string;
  trigger: RunTrigger;
  dryRun: boolean;
  todayISO: string;
  cutoffISO: string;
  live: BoardCount;
  historical: BoardCount;
  scanned: { live: number; historical: number; registrations: number; volunteers: number; logged: number };
  verdicts: Record<Verdict['kind'], number>;
  decided: { toHistorical: number; toLive: number };
  // What this pass actually did (or, dry run, would have done) — capped by run.maxMovesPerRun
  // and by the boards' headroom; `remaining` is what the next continuation pass still owes.
  planned: { toHistorical: number; toLive: number };
  moved: number;
  failed: number;
  ambiguous: number;
  settled: number;
  remaining: number;
  warnings: string[];
  // Non-null when the pass stopped before moving: the reason, already logged.
  error: string | null;
}

export interface Resolved {
  live: BoardSchema; historical: BoardSchema;
  liveCols: PersonColumnIds; historicalCols: PersonColumnIds;
  toHistorical: ColumnMapping[]; toLive: ColumnMapping[];
  liveGroup: string; historicalGroup: string;
}
export interface PersonColumnIds { lastGift: string; memberUntil: string; membershipTier: string; funraiseProfile: string | null; promoteStatus: string; promotedOn: string }

export class PassAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PassAbort';
  }
}

// What one operator-requested move did. 'refused' means the rule says this person belongs on
// Historical, so the next pass would send them straight back.
export type SingleMoveResult =
  | { outcome: 'moved' | 'dry-run'; itemId: string; reason: string; latestActivity: string | null }
  | { outcome: 'already-on-people' | 'not-found'; itemId: string }
  | { outcome: 'wrong-board'; itemId: string; boardId: string }
  | { outcome: 'refused'; itemId: string; latestActivity: string; cutoffISO: string }
  | { outcome: 'skipped' | 'failed' | 'ambiguous' | 'error'; itemId: string; error: string };

const HISTORICAL_ALERT_KIND = 'historical-capacity';
// Consecutive move failures that stop a pass: Monday is unhappy, not one odd item.
const MAX_CONSECUTIVE_FAILURES = 5;
// How long a pass's lease lasts before another pass may take it over: well past the longest pass
// a Worker invocation can run, so it only ever frees a lease whose holder died.
export const LEASE_MS = 30 * 60_000;

export async function runPass(deps: PassDeps, opts: PassOptions): Promise<PassReport | { skipped: string }> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  // One pass at a time, cron or HTTP, dry run or live (#64): even a dry run settles 'planned' rows,
  // and settling another pass's in-flight move would mark it failed.
  const leaseExpires = new Date(now().getTime() + LEASE_MS).toISOString();
  if (!(await deps.ledger.acquireLease(opts.runId, startedAt, leaseExpires))) {
    return { skipped: `another pass is running; run ${opts.runId} not started` };
  }
  try {
    const { created, existing } = await deps.ledger.startRun({ runId: opts.runId, trigger: opts.trigger, dryRun: opts.dryRun, startedAt });
    if (!created) {
      // A run that is still 'running' died mid-pass (the lease rules out one in progress); a cron
      // never retries the same run_id, and an operator chooses a new one.
      return { skipped: `run ${opts.runId} already recorded (${existing!.status})` };
    }
    try {
      const report = await executePass(deps, opts, now);
      await deps.ledger.finishRun(opts.runId, report.error === null ? 'ok' : 'failed', now().toISOString(), report);
      return report;
    } catch (err) {
      const message = errorText(err);
      console.error(`reclassify ${opts.runId}: pass failed: ${message}`);
      await deps.ledger.finishRun(opts.runId, 'failed', now().toISOString(), { error: message });
      throw err;
    }
  } finally {
    await deps.ledger.releaseLease(opts.runId);
  }
}

async function executePass(deps: PassDeps, opts: PassOptions, now: () => Date): Promise<PassReport> {
  const { config, monday, ledger } = deps;
  const todayISO = todayInZone(now(), config.window.timeZone);
  const cutoffISO = cutoffFor(todayISO, config.window.years);
  const warnings: string[] = [];
  const log = (msg: string) => console.log(`reclassify ${opts.runId}${opts.dryRun ? ' (dry run)' : ''}: ${msg}`);

  const resolved = await resolveBoards(monday, config);
  const live = countOf(resolved.live, config.thresholds.itemsLimit);
  const historical = countOf(resolved.historical, config.thresholds.itemsLimit);

  const report: PassReport = {
    runId: opts.runId, trigger: opts.trigger, dryRun: opts.dryRun, todayISO, cutoffISO, live, historical,
    scanned: { live: 0, historical: 0, registrations: 0, volunteers: 0, logged: 0 },
    verdicts: { live: 0, historical: 0, unknown: 0 },
    decided: { toHistorical: 0, toLive: 0 }, planned: { toHistorical: 0, toLive: 0 },
    moved: 0, failed: 0, ambiguous: 0, settled: 0, remaining: 0, warnings, error: null,
  };

  // 1. Settle rows an earlier pass left 'planned' or 'ambiguous' before deciding anything anew.
  report.settled = await settleUnsettled(deps, now);

  // 2. Read everything.
  const people = new Map<string, PersonFacts>();
  for (const [board, schema, cols] of [['live', resolved.live, resolved.liveCols], ['historical', resolved.historical, resolved.historicalCols]] as const) {
    for await (const item of pageAll(monday, Number(schema.id), personColumnIdList(cols))) {
      report.scanned[board] += 1;
      people.set(item.id, personFacts(item, board, cols));
    }
  }
  const bump = (personId: string, key: ActivityKey, dateISO: string | null) => {
    const p = people.get(personId);
    if (p === undefined || dateISO === null) return;
    if (p[key] === null || dateISO > p[key]!) p[key] = dateISO;
  };
  await readActivity(monday, config, bump, report.scanned);

  // 3. Decide.
  const rule = ruleOptions(config, todayISO, cutoffISO);
  const toHistorical: { p: PersonFacts; v: Verdict }[] = [];
  const toLive: { p: PersonFacts; v: Verdict }[] = [];
  for (const p of people.values()) {
    const v = classify(p, rule);
    report.verdicts[v.kind] += 1;
    if (p.board === 'live' && v.kind === 'historical') toHistorical.push({ p, v });
    if (p.board === 'historical' && v.kind === 'live') toLive.push({ p, v });
  }
  // Oldest activity first, so a capped pass takes the longest-lapsed people out first and brings
  // the most recently active ones back first.
  toHistorical.sort((a, b) => (a.v.latestActivity ?? '').localeCompare(b.v.latestActivity ?? ''));
  toLive.sort((a, b) => (b.v.latestActivity ?? '9').localeCompare(a.v.latestActivity ?? '9'));
  report.decided = { toHistorical: toHistorical.length, toLive: toLive.length };

  // 4. Fit the plan to this run's cap and the boards' headroom. Outbound first: headroom on the
  // live board is the whole point; inbound only as far as it then fits.
  const limit = config.thresholds.itemsLimit;
  const historicalRoom = Math.max(0, limit - historical.itemsCount);
  if (toHistorical.length > historicalRoom) {
    warnings.push(`People (Historical) has room for ${historicalRoom} of the ${toHistorical.length} people due to move there — it needs its own era split (migration-plan, Still open, item 4)`);
  }
  const outbound = toHistorical.slice(0, Math.min(config.run.maxMovesPerRun, historicalRoom));
  const liveRoom = Math.max(0, limit - (live.itemsCount - outbound.length));
  if (toLive.length > liveRoom) warnings.push(`People has room for ${liveRoom} of the ${toLive.length} people due to move back`);
  const inbound = toLive.slice(0, Math.min(config.run.maxMovesPerRun - outbound.length, liveRoom));
  report.planned = { toHistorical: outbound.length, toLive: inbound.length };
  report.remaining = (toHistorical.length - outbound.length) + (toLive.length - inbound.length);
  log(`today ${todayISO}, window from ${cutoffISO}: live ${live.itemsCount}/${limit} (${live.pct}%), historical ${historical.itemsCount}/${limit} (${historical.pct}%); ` +
    `${report.verdicts.unknown} with no evidence left in place; ${toHistorical.length} due out, ${toLive.length} due back; this pass: ${outbound.length} out, ${inbound.length} back`);

  // 5. Move.
  const plan: { p: PersonFacts; v: Verdict; direction: Direction; to: BoardSchema; group: string; mapping: ColumnMapping[] }[] = [
    ...outbound.map((x) => ({ ...x, direction: 'to-historical' as const, to: resolved.historical, group: resolved.historicalGroup, mapping: resolved.toHistorical })),
    ...inbound.map((x) => ({ ...x, direction: 'to-live' as const, to: resolved.live, group: resolved.liveGroup, mapping: resolved.toLive })),
  ];
  let consecutiveFailures = 0;
  let movedOut = 0;
  let movedIn = 0;
  for (const m of plan) {
    const from = m.p.board === 'live' ? resolved.live : resolved.historical;
    const at = now().toISOString();
    const id = await ledger.insertMove({
      runId: opts.runId, itemId: m.p.itemId, fromBoardId: from.id, toBoardId: m.to.id, direction: m.direction,
      latestActivity: m.v.latestActivity, reason: m.v.reason, status: opts.dryRun ? 'dry-run' : 'planned', plannedAt: at,
    });
    if (opts.dryRun) continue;
    try {
      await monday.moveItemToBoard(m.p.itemId, Number(m.to.id), m.group, m.mapping);
      await ledger.setMoveStatus(id, 'moved', now().toISOString());
      report.moved += 1;
      if (m.direction === 'to-historical') movedOut += 1; else movedIn += 1;
      consecutiveFailures = 0;
    } catch (err) {
      const message = errorText(err);
      if (err instanceof AmbiguousWriteError) {
        report.ambiguous += 1;
        await ledger.setMoveStatus(id, 'ambiguous', now().toISOString(), message);
        console.error(`reclassify ${opts.runId}: move of item ${m.p.itemId} ${m.direction} is ambiguous (settled next pass): ${message}`);
      } else {
        report.failed += 1;
        await ledger.setMoveStatus(id, 'failed', now().toISOString(), message);
        console.error(`reclassify ${opts.runId}: move of item ${m.p.itemId} ${m.direction} failed: ${message}`);
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        report.error = `stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive move failures`;
        report.remaining += plan.length - plan.indexOf(m) - 1;
        break;
      }
    }
  }

  // 6. Capacity warning for the historical board, on what it will hold after this pass.
  const historicalAfter = historical.itemsCount + movedOut - movedIn;
  const historicalPct = Math.round((historicalAfter / limit) * 100);
  if (historicalPct >= config.thresholds.historicalWarnPct) {
    const text = `People (Historical) is at ${historicalPct}% of its ${limit}-item limit (${historicalAfter} items) — it needs its own era split before it fills`;
    warnings.push(text);
    console.warn(`reclassify ${opts.runId}: ${text}`);
    await raiseHistoricalAlert(deps, opts, resolved.historical, text, now);
  }
  if (report.error !== null) console.error(`reclassify ${opts.runId}: ${report.error}`);
  log(`done: moved ${report.moved}, failed ${report.failed}, ambiguous ${report.ambiguous}, remaining ${report.remaining}`);
  return report;
}

// Moves one named person from People (Historical) to People, now, for an operator who can't wait
// for the next pass. Same safeguards as a pass (the lease, the column check, the ledger), but only
// in that direction, only for an item that really is on Historical, and only if the liveness rule
// agrees: a person with old activity would just go back on the next pass. Reads the activity
// boards in full, since their links can't be looked up by person.
export async function moveOneToPeople(deps: PassDeps, opts: { runId: string; itemId: string; dryRun: boolean }): Promise<SingleMoveResult> {
  const now = deps.now ?? (() => new Date());
  const { itemId } = opts;
  const leaseExpires = new Date(now().getTime() + LEASE_MS).toISOString();
  if (!(await deps.ledger.acquireLease(opts.runId, now().toISOString(), leaseExpires))) {
    return { outcome: 'skipped', itemId, error: 'another pass is running' };
  }
  try {
    return await executeSingleMove(deps, opts, now);
  } catch (err) {
    const message = errorText(err);
    console.error(`reclassify ${opts.runId}: move of item ${itemId} stopped: ${message}`);
    return { outcome: 'error', itemId, error: message };
  } finally {
    await deps.ledger.releaseLease(opts.runId);
  }
}

async function executeSingleMove(deps: PassDeps, opts: { runId: string; itemId: string; dryRun: boolean }, now: () => Date): Promise<SingleMoveResult> {
  const { config, monday, ledger } = deps;
  const { itemId, runId, dryRun } = opts;
  const boardId = await monday.getItemBoardId(itemId);
  if (boardId === null) return { outcome: 'not-found', itemId };
  if (boardId === String(config.boards.live.boardId)) return { outcome: 'already-on-people', itemId };
  if (boardId !== String(config.boards.historical.boardId)) return { outcome: 'wrong-board', itemId, boardId };

  const resolved = await resolveBoards(monday, config);
  const item = await monday.getItemValues(itemId, personColumnIdList(resolved.historicalCols));
  if (item === null) return { outcome: 'not-found', itemId };
  const person = personFacts(item, 'historical', resolved.historicalCols);
  await readActivity(monday, config, (personId, key, dateISO) => {
    if (personId !== itemId || dateISO === null) return;
    if (person[key] === null || dateISO > person[key]!) person[key] = dateISO;
  }, { registrations: 0, volunteers: 0, logged: 0 });

  const todayISO = todayInZone(now(), config.window.timeZone);
  const cutoffISO = cutoffFor(todayISO, config.window.years);
  // 'unknown' (no evidence) may move: no pass ever moves such a person, so the move sticks.
  const verdict = classify(person, ruleOptions(config, todayISO, cutoffISO));
  if (verdict.kind === 'historical') return { outcome: 'refused', itemId, latestActivity: verdict.latestActivity, cutoffISO };
  if (resolved.live.itemsCount >= config.thresholds.itemsLimit) {
    throw new PassAbort(`People has no room (${resolved.live.itemsCount} of ${config.thresholds.itemsLimit} items)`);
  }

  const { created, existing } = await ledger.startRun({ runId, trigger: 'single-move', dryRun, startedAt: now().toISOString() });
  if (!created) return { outcome: 'skipped', itemId, error: `run ${runId} already recorded (${existing!.status})` };
  const decided = { reason: verdict.reason, latestActivity: verdict.latestActivity };
  const id = await ledger.insertMove({
    runId, itemId, fromBoardId: resolved.historical.id, toBoardId: resolved.live.id, direction: 'to-live',
    ...decided, status: dryRun ? 'dry-run' : 'planned', plannedAt: now().toISOString(),
  });
  let result: SingleMoveResult;
  if (dryRun) {
    result = { outcome: 'dry-run', itemId, ...decided };
  } else {
    try {
      await monday.moveItemToBoard(itemId, Number(resolved.live.id), resolved.liveGroup, resolved.toLive);
      await ledger.setMoveStatus(id, 'moved', now().toISOString());
      result = { outcome: 'moved', itemId, ...decided };
    } catch (err) {
      const message = errorText(err);
      // An ambiguous row stays unsettled, and the next pass asks Monday where the item ended up.
      const outcome = err instanceof AmbiguousWriteError ? 'ambiguous' : 'failed';
      await ledger.setMoveStatus(id, outcome, now().toISOString(), message);
      console.error(`reclassify ${runId}: move of item ${itemId} to-live is ${outcome}: ${message}`);
      result = { outcome, itemId, error: message };
    }
  }
  await ledger.finishRun(runId, result.outcome === 'failed' || result.outcome === 'ambiguous' ? 'failed' : 'ok', now().toISOString(), result);
  console.log(`reclassify ${runId}: item ${itemId} to People: ${result.outcome}`);
  return result;
}

const personColumnIdList = (cols: PersonColumnIds): string[] =>
  [cols.lastGift, cols.memberUntil, cols.membershipTier, cols.promotedOn, ...(cols.funraiseProfile ? [cols.funraiseProfile] : [])];

const personFacts = (item: PageItem, board: Board, cols: PersonColumnIds): PersonFacts => ({
  itemId: item.id, board,
  lastGiftISO: dateOnly(item.text.get(cols.lastGift)),
  memberUntilISO: dateOnly(item.text.get(cols.memberUntil)),
  membershipTier: item.text.get(cols.membershipTier) ?? null,
  funraiseLinked: cols.funraiseProfile !== null && item.text.get(cols.funraiseProfile) !== null,
  latestRegistrationISO: null, latestVolunteerISO: null, latestLoggedISO: null,
  promotedOnISO: dateOnly(item.text.get(cols.promotedOn)),
});

const ruleOptions = (config: ReclassificationConfig, todayISO: string, cutoffISO: string) =>
  ({ todayISO, cutoffISO, lifetimeTierLabel: config.perpetual.lifetimeTierLabel, funraiseLinked: config.perpetual.funraiseLinked });

// Pages the optional activity boards, reporting each person's counted dates through `bump`.
type ActivityKey = 'latestRegistrationISO' | 'latestVolunteerISO' | 'latestLoggedISO';

export async function readActivity(
  monday: ReclassificationMondayClient, config: ReclassificationConfig,
  bump: (personId: string, key: ActivityKey, dateISO: string | null) => void,
  scanned: { registrations: number; volunteers: number; logged: number },
): Promise<void> {
  await readLoggedActivities(monday, config, (personId, dateISO) => bump(personId, 'latestLoggedISO', dateISO), scanned);
  if (config.eventRegistrations !== null) {
    const er = config.eventRegistrations;
    const events = await requireSchema(monday, er.events.boardId, 'Events');
    const startId = columnIdByTitle(events.columns, er.events.startColumn, `Events board ${events.id}`);
    const eventStart = new Map<string, string | null>();
    for await (const e of pageAll(monday, er.events.boardId, [startId])) eventStart.set(e.id, dateOnly(e.text.get(startId)));
    const regs = await requireSchema(monday, er.boardId, 'Event Registrations');
    const label = `Event Registrations board ${regs.id}`;
    const c = {
      attendee: columnIdByTitle(regs.columns, er.columns.attendee, label), event: columnIdByTitle(regs.columns, er.columns.event, label),
      attendance: columnIdByTitle(regs.columns, er.columns.attendance, label), source: columnIdByTitle(regs.columns, er.columns.source, label),
    };
    const counted = (r: PageItem) =>
      er.countedAttendanceLabels.includes(r.text.get(c.attendance) ?? '') || er.countedRegisteredSources.includes(r.text.get(c.source) ?? '');
    for await (const r of pageAll(monday, er.boardId, [c.attendee, c.event, c.attendance, c.source])) {
      scanned.registrations += 1;
      if (!counted(r)) continue;
      const start = (r.linked.get(c.event) ?? []).map((id) => eventStart.get(id) ?? null).find((d) => d !== null) ?? null;
      for (const personId of r.linked.get(c.attendee) ?? []) bump(personId, 'latestRegistrationISO', start);
    }
  }
  if (config.volunteers !== null) {
    const v = config.volunteers;
    const vol = await requireSchema(monday, v.boardId, 'Volunteers');
    const label = `Volunteers board ${vol.id}`;
    const c = { volunteer: columnIdByTitle(vol.columns, v.columns.volunteer, label), date: columnIdByTitle(vol.columns, v.columns.date, label) };
    for await (const r of pageAll(monday, v.boardId, [c.volunteer, c.date])) {
      scanned.volunteers += 1;
      for (const personId of r.linked.get(c.volunteer) ?? []) bump(personId, 'latestVolunteerISO', dateOnly(r.text.get(c.date)));
    }
  }
}

// Pages Activities (Logged), reporting each linked person's counted dates. An item with no Date or
// no Person counts for nobody; a Bulk Email isn't in countedTypeLabels. With sinceISO, Monday
// returns only items dated on or after it, rather than the whole board (#101).
export async function readLoggedActivities(
  monday: ReclassificationMondayClient, config: ReclassificationConfig,
  report: (personId: string, dateISO: string) => void,
  scanned: { logged: number },
  sinceISO?: string,
): Promise<void> {
  const la = config.loggedActivities;
  if (la === null) return;
  const board = await requireSchema(monday, la.boardId, 'Activities (Logged)');
  const label = `Activities (Logged) board ${board.id}`;
  const c = {
    person: columnIdByTitle(board.columns, la.columns.person, label), date: columnIdByTitle(board.columns, la.columns.date, label),
    activityType: columnIdByTitle(board.columns, la.columns.activityType, label),
  };
  const filter = sinceISO === undefined ? undefined : { dateOnOrAfter: { columnId: c.date, dateISO: sinceISO } };
  for await (const a of pageAll(monday, la.boardId, [c.person, c.date, c.activityType], filter)) {
    scanned.logged += 1;
    const date = dateOnly(a.text.get(c.date));
    if (date === null || !la.countedTypeLabels.includes(a.text.get(c.activityType) ?? '')) continue;
    for (const personId of a.linked.get(c.person) ?? []) report(personId, date);
  }
}

async function raiseHistoricalAlert(deps: PassDeps, opts: PassOptions, board: BoardSchema, text: string, now: () => Date): Promise<void> {
  const alert = deps.config.alerts.itRequests;
  if (alert === null || opts.dryRun) return;
  const last = await deps.ledger.lastAlertAt(board.id, HISTORICAL_ALERT_KIND);
  const cooldownMs = alert.cooldownDays * 86_400_000;
  if (last !== null && now().getTime() - new Date(last).getTime() < cooldownMs) return;
  try {
    const schema = await requireSchema(deps.monday, alert.boardId, 'IT Requests');
    const typeId = columnIdByTitle(schema.columns, alert.typeColumn, `IT Requests board ${schema.id}`);
    const itemId = await deps.monday.createItem(alert.boardId, text, { [typeId]: { label: alert.typeLabel } });
    await deps.ledger.recordAlert(board.id, HISTORICAL_ALERT_KIND, now().toISOString(), itemId);
  } catch (err) {
    // The warning is already in the log; the IT Requests item is a convenience, never a reason to fail a pass.
    console.error(`reclassify ${opts.runId}: IT Requests alert failed: ${errorText(err)}`);
  }
}

export async function settleUnsettled(deps: PassDeps, now: () => Date): Promise<number> {
  const rows = await deps.ledger.unsettledMoves();
  for (const row of rows) {
    const boardId = await deps.monday.getItemBoardId(row.itemId);
    const at = now().toISOString();
    if (boardId === row.toBoardId) await deps.ledger.setMoveStatus(row.id, 'moved', at, null);
    else if (boardId === row.fromBoardId) await deps.ledger.setMoveStatus(row.id, 'failed', at, 'never moved (settled by a later pass)');
    else await deps.ledger.setMoveStatus(row.id, 'failed', at, boardId === null ? 'item no longer visible (settled by a later pass)' : `item is on board ${boardId} (settled by a later pass)`);
  }
  return rows.length;
}

async function requireSchema(monday: ReclassificationMondayClient, boardId: number, label: string): Promise<BoardSchema> {
  if (boardId === 0) throw new PassAbort(`${label} board id is the 0 placeholder — fill in config`);
  const schema = await monday.getBoardSchema(boardId);
  if (schema === null) throw new PassAbort(`${label} board ${boardId} is not visible to this token`);
  return schema;
}

export async function resolveBoards(monday: ReclassificationMondayClient, config: ReclassificationConfig): Promise<Resolved> {
  const live = await requireSchema(monday, config.boards.live.boardId, 'People');
  const historical = await requireSchema(monday, config.boards.historical.boardId, 'People (Historical)');
  const cols = (schema: BoardSchema, label: string): PersonColumnIds => {
    const pc = config.peopleColumns;
    return {
      lastGift: columnIdByTitle(schema.columns, pc.lastGift, label), memberUntil: columnIdByTitle(schema.columns, pc.memberUntil, label),
      membershipTier: columnIdByTitle(schema.columns, pc.membershipTier, label),
      funraiseProfile: pc.funraiseProfile === null ? null : columnIdByTitle(schema.columns, pc.funraiseProfile, label),
      promoteStatus: columnIdByTitle(schema.columns, pc.promoteStatus, label), promotedOn: columnIdByTitle(schema.columns, pc.promotedOn, label),
    };
  };
  const toHistorical = moveMapping(live.columns, historical.columns);
  const toLive = moveMapping(historical.columns, live.columns);
  const describe = (m: { title: string; type: string }[]) => m.map((c) => `"${c.title}" (${c.type})`).join(', ');
  if (toHistorical.missing.length > 0 || toLive.missing.length > 0) {
    throw new PassAbort('the two People boards disagree on columns, so a move would drop values — ' +
      (toHistorical.missing.length ? `missing on People (Historical): ${describe(toHistorical.missing)}` : '') +
      (toHistorical.missing.length && toLive.missing.length ? '; ' : '') +
      (toLive.missing.length ? `missing on People: ${describe(toLive.missing)}` : ''));
  }
  const group = (schema: BoardSchema, configured: string | null, label: string): string => {
    if (configured !== null) {
      if (!schema.groups.some((g) => g.id === configured)) throw new PassAbort(`${label}: configured group "${configured}" does not exist`);
      return configured;
    }
    const first = schema.groups[0];
    if (first === undefined) throw new PassAbort(`${label}: board has no groups`);
    return first.id;
  };
  return {
    live, historical, liveCols: cols(live, `People board ${live.id}`), historicalCols: cols(historical, `People (Historical) board ${historical.id}`),
    toHistorical: toHistorical.mapping, toLive: toLive.mapping,
    liveGroup: group(live, config.boards.live.groupId, 'People'), historicalGroup: group(historical, config.boards.historical.groupId, 'People (Historical)'),
  };
}

export function countOf(schema: BoardSchema, configuredLimit: number): BoardCount {
  const itemsLimit = schema.itemsLimit ?? configuredLimit;
  return { boardId: schema.id, name: schema.name, itemsCount: schema.itemsCount, itemsLimit, pct: Math.round((schema.itemsCount / itemsLimit) * 100) };
}

export async function* pageAll(monday: ReclassificationMondayClient, boardId: number, columnIds: string[], filter?: PageFilter): AsyncGenerator<PageItem> {
  let cursor: string | null = null;
  do {
    const page: { items: PageItem[]; cursor: string | null } = await monday.pageItems(boardId, columnIds, cursor, filter);
    for (const item of page.items) yield item;
    cursor = page.cursor;
  } while (cursor !== null);
}
