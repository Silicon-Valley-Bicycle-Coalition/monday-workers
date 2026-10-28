import { AmbiguousWriteError } from './monday/graphql';
import type { ReclassificationMondayClient, BoardSchema, PageItem } from './monday/client';
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
  scanned: { live: number; historical: number; registrations: number; volunteers: number };
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

interface Resolved {
  live: BoardSchema; historical: BoardSchema;
  liveCols: PersonColumnIds; historicalCols: PersonColumnIds;
  toHistorical: ColumnMapping[]; toLive: ColumnMapping[];
  liveGroup: string; historicalGroup: string;
}
interface PersonColumnIds { lastGift: string; memberUntil: string; membershipTier: string; funraiseProfile: string | null }

export class PassAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PassAbort';
  }
}

const HISTORICAL_ALERT_KIND = 'historical-capacity';
// Consecutive move failures that stop a pass: Monday is unhappy, not one odd item.
const MAX_CONSECUTIVE_FAILURES = 5;
// How long a pass's lease lasts before another pass may take it over: well past the longest pass
// a Worker invocation can run, so it only ever frees a lease whose holder died.
const LEASE_MS = 30 * 60_000;

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
    scanned: { live: 0, historical: 0, registrations: 0, volunteers: 0 },
    verdicts: { live: 0, historical: 0, unknown: 0 },
    decided: { toHistorical: 0, toLive: 0 }, planned: { toHistorical: 0, toLive: 0 },
    moved: 0, failed: 0, ambiguous: 0, settled: 0, remaining: 0, warnings, error: null,
  };

  // 1. Settle rows an earlier pass left 'planned' or 'ambiguous' before deciding anything anew.
  report.settled = await settleUnsettled(deps, now);

  // 2. Read everything.
  const people = new Map<string, PersonFacts>();
  for (const [board, schema, cols] of [['live', resolved.live, resolved.liveCols], ['historical', resolved.historical, resolved.historicalCols]] as const) {
    const ids = [cols.lastGift, cols.memberUntil, cols.membershipTier, ...(cols.funraiseProfile ? [cols.funraiseProfile] : [])];
    for await (const item of pageAll(monday, Number(schema.id), ids)) {
      report.scanned[board] += 1;
      people.set(item.id, {
        itemId: item.id, board: board as Board,
        lastGiftISO: dateOnly(item.text.get(cols.lastGift)),
        memberUntilISO: dateOnly(item.text.get(cols.memberUntil)),
        membershipTier: item.text.get(cols.membershipTier) ?? null,
        funraiseLinked: cols.funraiseProfile !== null && item.text.get(cols.funraiseProfile) !== null,
        latestRegistrationISO: null, latestVolunteerISO: null,
      });
    }
  }
  const bump = (personId: string, key: 'latestRegistrationISO' | 'latestVolunteerISO', dateISO: string | null) => {
    const p = people.get(personId);
    if (p === undefined || dateISO === null) return;
    if (p[key] === null || dateISO > p[key]!) p[key] = dateISO;
  };
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
      report.scanned.registrations += 1;
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
      report.scanned.volunteers += 1;
      for (const personId of r.linked.get(c.volunteer) ?? []) bump(personId, 'latestVolunteerISO', dateOnly(r.text.get(c.date)));
    }
  }

  // 3. Decide.
  const rule = { todayISO, cutoffISO, lifetimeTierLabel: config.perpetual.lifetimeTierLabel, funraiseLinked: config.perpetual.funraiseLinked };
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

async function settleUnsettled(deps: PassDeps, now: () => Date): Promise<number> {
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

async function resolveBoards(monday: ReclassificationMondayClient, config: ReclassificationConfig): Promise<Resolved> {
  const live = await requireSchema(monday, config.boards.live.boardId, 'People');
  const historical = await requireSchema(monday, config.boards.historical.boardId, 'People (Historical)');
  const cols = (schema: BoardSchema, label: string): PersonColumnIds => {
    const pc = config.peopleColumns;
    return {
      lastGift: columnIdByTitle(schema.columns, pc.lastGift, label), memberUntil: columnIdByTitle(schema.columns, pc.memberUntil, label),
      membershipTier: columnIdByTitle(schema.columns, pc.membershipTier, label),
      funraiseProfile: pc.funraiseProfile === null ? null : columnIdByTitle(schema.columns, pc.funraiseProfile, label),
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

function countOf(schema: BoardSchema, configuredLimit: number): BoardCount {
  const itemsLimit = schema.itemsLimit ?? configuredLimit;
  return { boardId: schema.id, name: schema.name, itemsCount: schema.itemsCount, itemsLimit, pct: Math.round((schema.itemsCount / itemsLimit) * 100) };
}

async function* pageAll(monday: ReclassificationMondayClient, boardId: number, columnIds: string[]): AsyncGenerator<PageItem> {
  let cursor: string | null = null;
  do {
    const page: { items: PageItem[]; cursor: string | null } = await monday.pageItems(boardId, columnIds, cursor);
    for (const item of page.items) yield item;
    cursor = page.cursor;
  } while (cursor !== null);
}
