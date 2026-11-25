import type { AttendeeStore } from '../db/attendees';
import type { TrackerStore } from '../db/tracker';
import { isActive, statusText, type HttpMondayClient, type MondayItemColumns } from '../monday/client';
import type { EventbriteSyncConfig, TrackerConfig } from '../types';
import { errorMessage } from '../util/errorMessage';
import { planGrants, type GrantPlan } from './grants';
import { DATE_MISMATCH, isFrozen, MANY_EVENTS, qualify } from './qualify';
import { computeTotals, planRow, type Desired, type RowAction } from './totals';
import type { Totals, TrackerEvent, TrackerRow, Verdict } from './types';

// Keeps the Education Tracker's three totals and each linked event's Grant current
// (docs/superpowers/specs/2026-11-04-event-counts-design.md). Everything is read before anything is
// written, so a failed read changes nothing. A cron with no cursor: what fails is redone next hour.

const COMPLETED = 'Completed';

// Stop after this many failures in a row: Monday is likely down, and the next run picks it up.
const MAX_CONSECUTIVE_FAILURES = 3;

export interface TrackerSweepDeps {
  monday: Pick<HttpMondayClient, 'listBoardItems' | 'getItems' | 'listItemsLinkedTo' | 'changeColumnValues'>;
  store: TrackerStore;
  attendees: Pick<AttendeeStore, 'listByEvent'>;
  config: EventbriteSyncConfig;
  // Under the `off` write switch: plan and count, write nothing.
  dryRun: boolean;
}

export interface TrackerSweepResult {
  // Written, or for a dry run would be.
  grants: number;
  rows: number;
  cleared: number;
  // The item ids of the writes that failed.
  failed: string[];
  warnings: string[];
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
      return verdict.kind === 'ok' ? [{ eventItemId: verdict.event.itemId, funder: row.funder }] : [];
    }),
    events,
    records: grants,
    untouchable: new Set(rows.filter((row) => forGrant.get(row.itemId)!.kind === 'unknown').flatMap((row) => row.eventItemIds)),
    grantByFunder: tracker.grantByFunder,
  });
  for (const id of grantPlan.conflicts) warnings.push(`event ${id}: its tracker rows have different Funders; Grant left alone`);

  const desiredByEvent = new Map<string, Desired>();
  const rowPlan: { itemId: string; action: RowAction }[] = [];
  for (const row of rows) {
    const frozen = isFrozen(row.date, now);
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
    const action = planRow(row.cells, counts.get(row.itemId) ?? null, desired, frozen);
    if (action.kind !== 'nothing') rowPlan.push({ itemId: row.itemId, action });
  }

  const result: TrackerSweepResult = { grants: 0, rows: 0, cleared: 0, failed: [], warnings, dryRun };
  if (dryRun) {
    result.grants = grantPlan.writes.length;
    result.rows = rowPlan.filter(({ action }) => action.kind === 'write').length;
    result.cleared = rowPlan.filter(({ action }) => action.kind === 'clear').length;
    return result;
  }

  let consecutiveFailures = 0;
  for (const step of [...grantSteps(grantPlan, deps, eventsBoard, now), ...rowPlan.map((p) => rowStep(p.itemId, p.action, deps, tracker, now))]) {
    try {
      await step.run();
      if (step.counter !== null) result[step.counter]++;
      consecutiveFailures = 0;
    } catch (err) {
      console.error(`eventbrite-sync tracker: item ${step.itemId} (${step.columns}) failed: ${errorMessage(err)}`);
      result.failed.push(step.itemId);
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
    }
  }
  return result;
}

async function readRows({ monday }: TrackerSweepDeps, cfg: TrackerConfig): Promise<TrackerRow[]> {
  const items = await monday.listBoardItems(cfg.boardId, [
    cfg.crmEventColumn, cfg.registeredColumn, cfg.checkedInColumn, cfg.noShowColumn, cfg.dateColumn, cfg.statusColumn, cfg.funderColumn,
  ]);
  return items.map((item) => ({
    itemId: item.id,
    date: day(item, cfg.dateColumn),
    status: statusText(item, cfg.statusColumn),
    funder: statusText(item, cfg.funderColumn),
    eventItemIds: text(item, cfg.crmEventColumn).split(',').filter((id) => id !== ''),
    cells: {
      registered: number(item, cfg.registeredColumn),
      checkedIn: number(item, cfg.checkedInColumn),
      noShows: number(item, cfg.noShowColumn),
    },
  }));
}

async function readEvents({ monday, config }: TrackerSweepDeps, boardId: number, ids: Set<string>): Promise<Map<string, TrackerEvent>> {
  if (ids.size === 0) return new Map();
  const cols = config.attendeeSync.events;
  const items = await monday.getItems(boardId, [...ids], [
    cols.eventbriteIdColumn, cols.programColumn, cols.eventStatusColumn, cols.dateColumn, cols.endColumn, cols.grantColumn,
  ]);
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

// A short count is worse than a blank one, so an event's totals wait until every registration the
// ledger knows of is on the board.
async function desiredTotals(event: TrackerEvent, { monday, attendees, config }: TrackerSweepDeps, boardId: number): Promise<Desired> {
  const cols = config.attendeeSync.registrations;
  const [registrations, ledger] = await Promise.all([
    monday.listItemsLinkedTo(boardId, cols.eventLinkColumn, event.itemId, [cols.attendanceColumn]),
    attendees.listByEvent(event.eventbriteId),
  ]);
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
  run: () => Promise<void>;
}

// Monday before D1 throughout: a lost D1 write leaves a value that reads as a person's, which is safe.
function grantSteps(plan: GrantPlan, { monday, store, config }: TrackerSweepDeps, boardId: number, now: Date): Step[] {
  const columns = config.attendeeSync.events.grantColumn;
  const at = now.toISOString();
  return [
    ...plan.writes.map(({ eventItemId, grant }): Step => ({
      itemId: eventItemId, columns, counter: 'grants',
      run: async () => {
        await monday.changeColumnValues(boardId, eventItemId, { [columns]: grant === null ? null : { labels: [grant] } });
        if (grant === null) await store.deleteGrant(eventItemId);
        else await store.saveGrant(eventItemId, grant, at);
      },
    })),
    ...plan.remember.map(({ eventItemId, grant }): Step => ({ itemId: eventItemId, columns: 'D1', counter: null, run: () => store.saveGrant(eventItemId, grant, at) })),
    ...plan.forget.map((eventItemId): Step => ({ itemId: eventItemId, columns: 'D1', counter: null, run: () => store.deleteGrant(eventItemId) })),
  ];
}

function rowStep(itemId: string, action: RowAction, { monday, store }: TrackerSweepDeps, cfg: TrackerConfig, now: Date): Step {
  const columns = [cfg.registeredColumn, cfg.checkedInColumn, cfg.noShowColumn].join(', ');
  const write = (totals: Totals | null) => monday.changeColumnValues(cfg.boardId, itemId, {
    [cfg.registeredColumn]: totals === null ? '' : String(totals.registered),
    [cfg.checkedInColumn]: totals === null ? '' : String(totals.checkedIn),
    [cfg.noShowColumn]: totals === null ? '' : String(totals.noShows),
  });
  return {
    itemId,
    columns,
    counter: action.kind === 'write' ? 'rows' : action.kind === 'clear' ? 'cleared' : null,
    run: async () => {
      if (action.kind === 'clear') {
        await write(null);
        await store.deleteCounts(itemId);
      } else if (action.kind !== 'nothing') {
        const { eventItemId, totals } = action;
        if (action.kind === 'write') await write(totals);
        await store.saveCounts({ trackerItemId: itemId, eventItemId, totals }, now.toISOString());
      }
    },
  };
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
  if (result.grants + result.rows + result.cleared + result.failed.length === 0) return;
  const counts = `${result.grants} grant(s), ${result.rows} row(s) and ${result.cleared} cleared row(s)`;
  if (result.dryRun) console.log(`eventbrite-sync tracker: ${counts} to write (dry run, nothing written)`);
  else if (result.failed.length > 0) console.error(`eventbrite-sync tracker: wrote ${counts}, failed ${result.failed.length} (${result.failed.join(', ')})`);
  else console.log(`eventbrite-sync tracker: wrote ${counts}`);
}
