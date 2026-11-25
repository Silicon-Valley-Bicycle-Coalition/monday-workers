import type { AttendeeStore } from '../db/attendees';
import type { TrackerStore } from '../db/tracker';
import { isTerminalError } from '../errors';
import { isActive, statusText, type HttpMondayClient, type MondayItemColumns } from '../monday/client';
import type { EventbriteSyncConfig, TrackerConfig } from '../types';
import { errorMessage } from '../util/errorMessage';
import { planGrants, type GrantPlan, type GrantWrite } from './grants';
import { DATE_MISMATCH, isFrozen, MANY_EVENTS, qualify } from './qualify';
import { computeTotals, hasNumbers, planRow, sameNumbers, type Desired, type RowAction } from './totals';
import type { Totals, TrackerEvent, TrackerRow, Verdict } from './types';

// Keeps the Education Tracker's three totals and each linked event's Grant current
// (docs/superpowers/specs/2026-11-04-event-counts-design.md). Everything is read before anything is
// written, so a failed read changes nothing. A cron with no cursor: what fails is redone next hour.

const COMPLETED = 'Completed';

// Stop after this many failures in a row: Monday or D1 is likely down, and the next run picks it up.
// A write Monday refuses on its content doesn't count, or one missing label would stop every total.
const MAX_CONSECUTIVE_FAILURES = 3;

// A run that would clear more than this clears nothing. Fixing links clears a few things; a renamed
// Funder label or a mass edit of the tracker would empty a funder's report.
const MAX_CLEARS = 5;

export interface TrackerSweepDeps {
  monday: Pick<HttpMondayClient, 'listBoardItems' | 'getItems' | 'listItemsLinkedTo' | 'changeColumnValues'>;
  store: TrackerStore;
  attendees: Pick<AttendeeStore, 'listByEvent'>;
  config: EventbriteSyncConfig;
  // Under the `off` write switch: plan and count, write nothing.
  dryRun: boolean;
}

export interface TrackerSweepResult {
  // Written, or for a dry run would be. `cleared` counts rows and Grants.
  grants: number;
  rows: number;
  cleared: number;
  // The item ids of the writes that failed.
  failed: string[];
  warnings: string[];
  // Clears held back because there were more than MAX_CLEARS.
  braked: number;
  // Changes not tried because the run stopped early.
  unattempted: number;
  dryRun: boolean;
}

export async function sweepTracker(now: Date, deps: TrackerSweepDeps): Promise<TrackerSweepResult> {
  const { store, config, dryRun } = deps;
  const tracker = config.attendeeSync.tracker;
  const eventsBoard = config.monday.boards.events;
  const registrationsBoard = config.monday.boards['event-registrations'];
  if (tracker === null || eventsBoard === null || registrationsBoard === null) {
    throw new Error('config: the tracker job needs attendeeSync.tracker and the events and event-registrations boards');
  }
  const warnings: string[] = [];

  const rows = await readRows(deps, tracker);
  // An emptied tracker isn't expected, and planning from one would clear every Grant.
  if (rows.length === 0) throw new Error(`Monday returned no tracker rows on board ${tracker.boardId}; nothing changed`);
  const [counts, grants] = await Promise.all([store.listCounts(), store.listGrants()]);
  const events = await readEvents(deps, eventsBoard, new Set([...rows.flatMap((row) => row.eventItemIds), ...grants.keys()]));

  const guards = { skipStatusLabels: tracker.skipStatusLabels, volunteerPrograms: config.attendeeSync.volunteerPrograms };
  const forGrant = new Map<string, Verdict>(rows.map((row) => [row.itemId, qualify(row, events, tracker.grantStartDate, guards)]));
  for (const row of rows) {
    const verdict = forGrant.get(row.itemId)!;
    if (verdict.kind === 'unknown') warnings.push(`row ${row.itemId}: linked event ${row.eventItemIds[0]} wasn't returned; left alone`);
    else if (verdict.kind === 'no' && [DATE_MISMATCH, MANY_EVENTS].includes(verdict.reason) && !isFrozen(row.date, now)) {
      warnings.push(`row ${row.itemId}: ${verdict.reason} (event ${row.eventItemIds.join(', ')})`);
    }
  }

  const grantPlan = planGrants({
    votes: rows.flatMap((row) => {
      const verdict = forGrant.get(row.itemId)!;
      return verdict.kind === 'ok' ? [{ eventItemId: verdict.event.itemId, trackerItemId: row.itemId, funder: row.funder }] : [];
    }),
    events,
    records: grants,
    rowsRead: new Set(rows.map((row) => row.itemId)),
    untouchable: new Set(rows.filter((row) => forGrant.get(row.itemId)!.kind === 'unknown').flatMap((row) => row.eventItemIds)),
    grantByFunder: tracker.grantByFunder,
  });
  for (const id of grantPlan.conflicts) warnings.push(`event ${id}: its tracker rows have different Funders; Grant left alone`);

  const desiredByEvent = new Map<string, Desired>();
  const rowPlan: { row: TrackerRow; action: RowAction }[] = [];
  for (const row of rows) {
    const record = counts.get(row.itemId) ?? null;
    // Also by the Date its numbers were written under, so blanking or moving Date can't reopen a
    // closed class. Once emptied, a row starts over.
    const frozen = isFrozen(row.date, now) || (record !== null && hasNumbers(row.cells) && isFrozen(record.date, now));
    let desired: Desired = { kind: 'none' };
    const verdict = qualify(row, events, tracker.startDate, guards);
    if (verdict.kind === 'unknown') desired = verdict;
    else if (verdict.kind === 'ok' && verdict.event.status === COMPLETED && !frozen) {
      const known = desiredByEvent.get(verdict.event.itemId);
      desired = known ?? await desiredTotals(verdict.event, deps, registrationsBoard);
      if (known === undefined) {
        desiredByEvent.set(verdict.event.itemId, desired);
        if (desired.kind === 'hold') warnings.push(`event ${verdict.event.itemId}: not every registration is written yet; its totals wait`);
      }
    }
    const action = planRow(row.cells, record, desired, frozen);
    if (action.kind !== 'nothing') rowPlan.push({ row, action });
  }

  const steps = [
    ...grantSteps(grantPlan, deps, eventsBoard, now),
    ...rowPlan.map(({ row, action }) => rowStep(row, action, deps, tracker, now)),
  ];
  const clears = steps.filter((step) => step.counter === 'cleared').length;
  const braked = clears > MAX_CLEARS ? clears : 0;
  const todo = braked === 0 ? steps : steps.filter((step) => step.counter !== 'cleared');

  const result: TrackerSweepResult = { grants: 0, rows: 0, cleared: 0, failed: [], warnings, braked, unattempted: 0, dryRun };
  if (dryRun) {
    for (const { counter } of todo) if (counter !== null) result[counter]++;
    return result;
  }

  let consecutiveFailures = 0;
  for (const [index, step] of todo.entries()) {
    try {
      const done = await step.run();
      if (done && step.counter !== null) result[step.counter]++;
      consecutiveFailures = 0;
    } catch (err) {
      console.error(`eventbrite-sync tracker: item ${step.itemId} (${step.columns}) failed: ${errorMessage(err)}`);
      result.failed.push(step.itemId);
      if (!isTerminalError(err) && ++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        result.unattempted = todo.length - index - 1;
        break;
      }
    }
  }
  return result;
}

// Monday leaves a deleted or retyped column out of an item rather than refusing the read, and every
// cell would then look blank. That is a failed read, not a board of blanks.
function withColumns(items: MondayItemColumns[], columnIds: string[], board: string): MondayItemColumns[] {
  for (const item of items) {
    const missing = columnIds.filter((id) => !(id in item.columns));
    if (missing.length > 0) throw new Error(`${board} item ${item.id} came back without column ${missing.join(', ')}; nothing changed`);
  }
  return items;
}

async function readRows({ monday }: TrackerSweepDeps, cfg: TrackerConfig): Promise<TrackerRow[]> {
  const columns = [...writtenColumns(cfg), cfg.crmEventColumn, cfg.dateColumn, cfg.statusColumn, cfg.funderColumn];
  const items = withColumns(await monday.listBoardItems(cfg.boardId, columns), columns, 'tracker');
  return items.map((item) => ({
    itemId: item.id,
    date: day(item, cfg.dateColumn),
    status: statusText(item, cfg.statusColumn),
    funder: statusText(item, cfg.funderColumn),
    ...linkAndCells(item, cfg),
  }));
}

const writtenColumns = (cfg: TrackerConfig): string[] => [cfg.registeredColumn, cfg.checkedInColumn, cfg.noShowColumn];

function linkAndCells(item: MondayItemColumns, cfg: TrackerConfig): Pick<TrackerRow, 'eventItemIds' | 'cells'> {
  return {
    eventItemIds: text(item, cfg.crmEventColumn).split(',').filter((id) => id !== ''),
    cells: {
      registered: number(item, cfg.registeredColumn),
      checkedIn: number(item, cfg.checkedInColumn),
      noShows: number(item, cfg.noShowColumn),
    },
  };
}

// Whether a row still has the link and numbers the plan was made from. Read just before its write,
// because staff type these numbers right after a class and a run can take a while to get to a row.
async function unchanged(row: TrackerRow, { monday }: TrackerSweepDeps, cfg: TrackerConfig): Promise<boolean> {
  const columns = [...writtenColumns(cfg), cfg.crmEventColumn];
  const [item] = withColumns(await monday.getItems(cfg.boardId, [row.itemId], columns), columns, 'tracker');
  if (!isActive(item)) return false;
  const current = linkAndCells(item, cfg);
  return sameNumbers(current.cells, row.cells) && current.eventItemIds.join() === row.eventItemIds.join();
}

async function readEvents({ monday, config }: TrackerSweepDeps, boardId: number, ids: Set<string>): Promise<Map<string, TrackerEvent>> {
  if (ids.size === 0) return new Map();
  const cols = config.attendeeSync.events;
  const columns = [cols.eventbriteIdColumn, cols.programColumn, cols.eventStatusColumn, cols.dateColumn, cols.endColumn, cols.grantColumn];
  const items = withColumns(await monday.getItems(boardId, [...ids], columns), columns, 'Events');
  return new Map(items.map((item) => [item.id, {
    itemId: item.id,
    active: isActive(item),
    eventbriteId: text(item, cols.eventbriteIdColumn),
    program: statusText(item, cols.programColumn),
    status: statusText(item, cols.eventStatusColumn),
    date: day(item, cols.dateColumn),
    end: day(item, cols.endColumn),
    grant: text(item, cols.grantColumn),
  }]));
}

// A short count is worse than a blank one, so an event's totals wait while the ledger has a
// registration that isn't written, or has some and the board lists none.
async function desiredTotals(event: TrackerEvent, { monday, attendees, config }: TrackerSweepDeps, boardId: number): Promise<Desired> {
  const cols = config.attendeeSync.registrations;
  const [registrations, ledger] = await Promise.all([
    monday.listItemsLinkedTo(boardId, cols.eventLinkColumn, event.itemId, [cols.attendanceColumn]),
    attendees.listByEvent(event.eventbriteId),
  ]);
  withColumns(registrations, [cols.attendanceColumn], 'Event Registrations');
  const unsettled = ledger.some((row) => row.status !== 'written') || (registrations.length === 0 && ledger.length > 0);
  if (unsettled) return { kind: 'hold', eventItemId: event.itemId };
  const totals = computeTotals(registrations.map((item) => statusText(item, cols.attendanceColumn)));
  return totals === null ? { kind: 'none' } : { kind: 'totals', eventItemId: event.itemId, totals };
}

interface Step {
  itemId: string;
  // For the failure line.
  columns: string;
  counter: 'grants' | 'rows' | 'cleared' | null;
  // False when it found nothing left to do.
  run: () => Promise<boolean>;
}

// Monday before D1 throughout: a lost D1 write leaves a value that reads as a person's, which is safe.
function grantSteps(plan: GrantPlan, { monday, store, config }: TrackerSweepDeps, boardId: number, now: Date): Step[] {
  const columns = config.attendeeSync.events.grantColumn;
  const at = now.toISOString();
  const save = async ({ eventItemId, grant, trackerItemId }: GrantWrite): Promise<boolean> => {
    await store.saveGrant(eventItemId, { grant, trackerItemId }, at);
    return true;
  };
  const drop = async (eventItemId: string): Promise<boolean> => {
    await store.deleteGrant(eventItemId);
    return true;
  };
  return [
    ...plan.writes.map((write): Step => ({
      itemId: write.eventItemId, columns, counter: 'grants',
      run: async () => {
        await monday.changeColumnValues(boardId, write.eventItemId, { [columns]: { labels: [write.grant] } });
        return save(write);
      },
    })),
    ...plan.clears.map((eventItemId): Step => ({
      itemId: eventItemId, columns, counter: 'cleared',
      run: async () => {
        await monday.changeColumnValues(boardId, eventItemId, { [columns]: null });
        return drop(eventItemId);
      },
    })),
    ...plan.remember.map((write): Step => ({ itemId: write.eventItemId, columns: 'D1', counter: null, run: () => save(write) })),
    ...plan.forget.map((eventItemId): Step => ({ itemId: eventItemId, columns: 'D1', counter: null, run: () => drop(eventItemId) })),
  ];
}

function rowStep(row: TrackerRow, action: RowAction, deps: TrackerSweepDeps, cfg: TrackerConfig, now: Date): Step {
  const { monday, store } = deps;
  const columns = writtenColumns(cfg).join(', ');
  const cell = (value: number | undefined): string => (value === undefined ? '' : String(value));
  const write = async (totals: Totals | null): Promise<boolean> => {
    if (!(await unchanged(row, deps, cfg))) return false;
    await monday.changeColumnValues(cfg.boardId, row.itemId, {
      [cfg.registeredColumn]: cell(totals?.registered),
      [cfg.checkedInColumn]: cell(totals?.checkedIn),
      [cfg.noShowColumn]: cell(totals?.noShows),
    });
    return true;
  };
  const run = async (): Promise<boolean> => {
    switch (action.kind) {
      case 'nothing':
        return false;
      case 'clear':
        if (!(await write(null))) return false;
        await store.deleteCounts(row.itemId);
        return true;
      case 'forget':
        await store.deleteCounts(row.itemId);
        return true;
      case 'write':
        if (!(await write(action.totals))) return false;
        break;
      case 'remember':
        break;
    }
    await store.saveCounts({ trackerItemId: row.itemId, eventItemId: action.eventItemId, date: row.date, totals: action.totals }, now.toISOString());
    return true;
  };
  return { itemId: row.itemId, columns, counter: action.kind === 'write' ? 'rows' : action.kind === 'clear' ? 'cleared' : null, run };
}

const text = (item: MondayItemColumns, column: string): string => (item.columns[column] ?? '').trim();

// A date column's text may carry a time after the day.
const day = (item: MondayItemColumns, column: string): string => text(item, column).slice(0, 10);

const number = (item: MondayItemColumns, column: string): number | null => {
  const value = text(item, column);
  return value === '' ? null : Number(value);
};

// Quiet when nothing changed, which is most hours. Warnings repeat every run, so they're logged daily.
export function logTrackerSummary(result: TrackerSweepResult, logWarnings: boolean): void {
  if (logWarnings) for (const warning of result.warnings) console.warn(`eventbrite-sync tracker: ${warning}`);
  const { grants, rows, cleared, failed, braked, unattempted, dryRun } = result;
  if (braked > 0) console.error(`eventbrite-sync tracker: held back ${braked} clears, too many for one run; check the tracker's links and Funder labels`);
  if (grants + rows + cleared + failed.length === 0) return;
  const counts = `${grants} grant(s), ${rows} row(s) and ${cleared} clear(s)`;
  if (dryRun) console.log(`eventbrite-sync tracker: ${counts} to write (dry run, nothing written)`);
  else if (failed.length > 0) console.error(`eventbrite-sync tracker: wrote ${counts}, failed ${failed.length} (${failed.join(', ')})${unattempted > 0 ? `, ${unattempted} not tried` : ''}`);
  else console.log(`eventbrite-sync tracker: wrote ${counts}`);
}
