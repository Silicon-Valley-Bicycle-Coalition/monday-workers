import { describe, it, expect, vi, afterEach } from 'vitest';
import type { TrackerStore } from '../db/tracker';
import type { MondayItemColumns } from '../monday/client';
import { mondayItem } from '../test/mondayItem';
import { testConfig, withTracker } from '../test/testConfig';
import type { AttendeeRow, EventbriteSyncConfig } from '../types';
import { logTrackerSummary, sweepTracker, type TrackerSweepDeps, type TrackerSweepResult } from './sweep';
import type { TrackerRecord } from './totals';

const NOW = new Date('2026-11-16T16:00:00Z');
const TRACKER_BOARD = 777;
const EVENTS_BOARD = 222;

interface RowInput { id?: string; date?: string; status?: string; funder?: string | null; link?: string; cells?: [string, string, string] }
function row({ id = '1', date = '2026-11-14', status = 'Reporting', funder = 'VTA', link = '900', cells = ['', '', ''] }: RowInput = {}): MondayItemColumns {
  return mondayItem(id, 'Secret class name', {
    tr_date_col: date, tr_status_col: status, tr_funder_col: funder ?? 'Other', tr_event_col: link,
    tr_reg_col: cells[0], tr_in_col: cells[1], tr_no_col: cells[2],
    // An empty status cell: Monday's text is label id 5's, and only the null value says it's blank.
  }, funder === null ? { values: { tr_funder_col: null } } : {});
}

interface EventInput { id?: string; status?: string; grant?: string; state?: string; date?: string; ebId?: string }
function event({ id = '900', status = 'Completed', grant = 'VTA', state = 'active', date = '2026-11-14', ebId = `eb-${id}` }: EventInput = {}): MondayItemColumns {
  return mondayItem(id, 'Secret event name', {
    ev_id_col: ebId, ev_program_col: 'Public', ev_status_col: status, ev_date_col: date, ev_end_col: date, ev_grant_col: grant,
  }, { state });
}

const registration = (id: string, attendance: string) => mondayItem(id, 'Secret person', { att_attendance_col: attendance });
const ATTENDED = [registration('r1', 'Attended'), registration('r2', 'Registered'), registration('r3', 'Canceled')];
const attendee = (status: AttendeeRow['status']) => ({ status }) as AttendeeRow;

interface World {
  rows?: MondayItemColumns[];
  events?: MondayItemColumns[];
  registrations?: Record<string, MondayItemColumns[]>;
  ledger?: Record<string, AttendeeRow[]>;
  counts?: TrackerRecord[];
  grants?: [string, string][];
  dryRun?: boolean;
}

function setup(world: World = {}) {
  const config: EventbriteSyncConfig = withTracker(testConfig());
  const calls: string[] = [];
  const changeColumnValues = vi.fn<TrackerSweepDeps['monday']['changeColumnValues']>(async (_board, id) => { calls.push(`monday ${id}`); });
  const listItemsLinkedTo = vi.fn<TrackerSweepDeps['monday']['listItemsLinkedTo']>(async (_board, _column, id) => (world.registrations ?? { 900: ATTENDED })[id] ?? []);
  const store = {
    listCounts: async () => new Map((world.counts ?? []).map((c) => [c.trackerItemId, c])),
    saveCounts: vi.fn<TrackerStore['saveCounts']>(async (r) => { calls.push(`saveCounts ${r.trackerItemId}`); }),
    deleteCounts: vi.fn<TrackerStore['deleteCounts']>(async (id) => { calls.push(`deleteCounts ${id}`); }),
    // Grant is settled unless a test says otherwise, so a totals test sees only totals.
    listGrants: async () => new Map(world.grants ?? [['900', 'VTA']]),
    saveGrant: vi.fn<TrackerStore['saveGrant']>(async (id, grant) => { calls.push(`saveGrant ${id} ${grant}`); }),
    deleteGrant: vi.fn<TrackerStore['deleteGrant']>(async (id) => { calls.push(`deleteGrant ${id}`); }),
  };
  const getItems = vi.fn<TrackerSweepDeps['monday']['getItems']>(async (_board, ids) => (world.events ?? [event()]).filter((e) => ids.includes(e.id)));
  const deps: TrackerSweepDeps = {
    monday: { listBoardItems: async () => world.rows ?? [row()], getItems, listItemsLinkedTo, changeColumnValues },
    store,
    attendees: { listByEvent: async (id) => (world.ledger ?? {})[id] ?? [attendee('written')] },
    config,
    dryRun: world.dryRun ?? false,
  };
  return { deps, store, calls, changeColumnValues, listItemsLinkedTo };
}

const ours: TrackerRecord = { trackerItemId: '1', eventItemId: '900', totals: { registered: 3, checkedIn: 1, noShows: 1 } };
const TOTALS = { tr_reg_col: '3', tr_in_col: '1', tr_no_col: '1' };
const CLEARED = { tr_reg_col: '', tr_in_col: '', tr_no_col: '' };

describe('sweepTracker totals', () => {
  it('writes a completed class’s totals in one call, then records them', async () => {
    const { deps, changeColumnValues, store, calls } = setup();
    const result = await sweepTracker(NOW, deps);
    expect(changeColumnValues.mock.calls).toEqual([[TRACKER_BOARD, '1', TOTALS]]);
    expect(store.saveCounts).toHaveBeenCalledWith(ours, NOW.toISOString());
    expect(calls).toEqual(['monday 1', 'saveCounts 1']);
    expect(result).toEqual({ grants: 0, rows: 1, cleared: 0, failed: [], warnings: [], dryRun: false });
  });

  it('writes nothing again while nothing changed', async () => {
    const { deps, calls } = setup({ rows: [row({ cells: ['3', '1', '1'] })], counts: [ours] });
    await sweepTracker(NOW, deps);
    expect(calls).toEqual([]);
  });

  it('leaves an upcoming class’s totals alone, but writes its Grant', async () => {
    const { deps, changeColumnValues, listItemsLinkedTo } = setup({ events: [event({ status: 'Upcoming', grant: '' })], grants: [] });
    await sweepTracker(NOW, deps);
    expect(changeColumnValues.mock.calls).toEqual([[EVENTS_BOARD, '900', { ev_grant_col: { labels: ['VTA'] } }]]);
    expect(listItemsLinkedTo).not.toHaveBeenCalled();
  });

  it('leaves a person’s numbers alone', async () => {
    const { deps, calls } = setup({ rows: [row({ cells: ['36', '', ''] })] });
    await sweepTracker(NOW, deps);
    expect(calls).toEqual([]);
  });

  it('clears its own totals when the event is archived', async () => {
    const { deps, changeColumnValues, calls } = setup({ rows: [row({ cells: ['3', '1', '1'] })], counts: [ours], events: [event({ state: 'archived' })] });
    const result = await sweepTracker(NOW, deps);
    expect(changeColumnValues.mock.calls).toEqual([[TRACKER_BOARD, '1', CLEARED]]);
    expect(calls).toEqual(['monday 1', 'deleteCounts 1']);
    expect(result.cleared).toBe(1);
  });

  it('clears its own totals when the row is unlinked', async () => {
    const { deps, calls } = setup({ rows: [row({ cells: ['3', '1', '1'], link: '' })], counts: [ours], grants: [] });
    await sweepTracker(NOW, deps);
    expect(calls).toEqual(['monday 1', 'deleteCounts 1']);
  });

  it('replaces them when the row is relinked', async () => {
    const { deps, changeColumnValues, store } = setup({
      rows: [row({ cells: ['3', '1', '1'], link: '901' })], counts: [ours], grants: [['901', 'VTA']], events: [event({ id: '901' })],
      registrations: { 901: [registration('r9', 'Attended')] },
    });
    await sweepTracker(NOW, deps);
    expect(changeColumnValues.mock.calls).toEqual([[TRACKER_BOARD, '1', { tr_reg_col: '1', tr_in_col: '1', tr_no_col: '0' }]]);
    expect(store.saveCounts.mock.calls[0]![0].eventItemId).toBe('901');
  });

  it.each(['queued', 'received', 'failed', 'skipped'] as const)('holds totals while a registration is %s, and says which event', async (status) => {
    const { deps, calls } = setup({ ledger: { 'eb-900': [attendee('written'), attendee(status)] } });
    const result = await sweepTracker(NOW, deps);
    expect(calls).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('900');
  });

  it('holds its own totals when Monday lists no registrations but the ledger has some', async () => {
    const { deps, calls } = setup({ rows: [row({ cells: ['3', '1', '1'] })], counts: [ours], registrations: {} });
    const result = await sweepTracker(NOW, deps);
    expect(calls).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it('leaves a frozen row alone and doesn’t count it', async () => {
    const { deps, calls, listItemsLinkedTo } = setup({ rows: [row({ date: '2026-11-01' })], events: [event({ date: '2026-11-01' })] });
    await sweepTracker(new Date('2026-12-15T16:00:00Z'), deps);
    expect(calls).toEqual([]);
    expect(listItemsLinkedTo).not.toHaveBeenCalled();
  });

  it('reads one event’s registrations once for two rows, and fills both', async () => {
    const { deps, calls, listItemsLinkedTo } = setup({ rows: [row(), row({ id: '2' })] });
    await sweepTracker(NOW, deps);
    expect(calls).toEqual(['monday 1', 'saveCounts 1', 'monday 2', 'saveCounts 2']);
    expect(listItemsLinkedTo).toHaveBeenCalledTimes(1);
  });

  it('warns about a date that doesn’t match, and writes nothing', async () => {
    const { deps, calls } = setup({ rows: [row({ date: '2026-11-13' })], grants: [] });
    const result = await sweepTracker(NOW, deps);
    expect(calls).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('row 1')]);
  });
});

describe('sweepTracker grants', () => {
  const settled = { rows: [row({ cells: ['3', '1', '1'] })], counts: [ours] };

  it('records a Grant after writing it', async () => {
    const { deps, calls } = setup({ ...settled, events: [event({ grant: '' })], grants: [] });
    const result = await sweepTracker(NOW, deps);
    expect(calls).toEqual(['monday 900', 'saveGrant 900 VTA']);
    expect(result.grants).toBe(1);
  });

  it('adopts a Grant staff already set, without writing Monday', async () => {
    const { deps, calls } = setup({ ...settled, grants: [] });
    await sweepTracker(NOW, deps);
    expect(calls).toEqual(['saveGrant 900 VTA']);
  });

  it('clears the Grant of an event that lost its row', async () => {
    const { deps, changeColumnValues, calls } = setup({ ...settled, events: [event(), event({ id: '905' })], grants: [['900', 'VTA'], ['905', 'VTA']] });
    await sweepTracker(NOW, deps);
    expect(changeColumnValues.mock.calls).toEqual([[EVENTS_BOARD, '905', { ev_grant_col: null }]]);
    expect(calls).toEqual(['monday 905', 'deleteGrant 905']);
  });

  it('forgets a Grant a person changed', async () => {
    const { deps, calls } = setup({ ...settled, events: [event(), event({ id: '905', grant: 'SMCTA' })], grants: [['900', 'VTA'], ['905', 'VTA']] });
    await sweepTracker(NOW, deps);
    expect(calls).toEqual(['deleteGrant 905']);
  });

  it('reads an empty Funder as blank, not as the label Monday shows for it', async () => {
    const { deps, calls } = setup({ rows: [row({ cells: ['3', '1', '1'], funder: null }), row({ id: '2', cells: ['3', '1', '1'] })], counts: [ours, { ...ours, trackerItemId: '2' }], events: [event({ grant: '' })], grants: [] });
    const result = await sweepTracker(NOW, deps);
    expect(calls).toEqual(['monday 900', 'saveGrant 900 VTA']);
    expect(result.warnings).toEqual([]);
  });

  it('warns and writes nothing when two rows disagree', async () => {
    const { deps, calls } = setup({ rows: [row({ cells: ['3', '1', '1'] }), row({ id: '2', funder: 'SMC', cells: ['3', '1', '1'] })], counts: [ours, { ...ours, trackerItemId: '2' }] });
    const result = await sweepTracker(NOW, deps);
    expect(calls).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('900')]);
  });

  it('corrects Grant on a frozen row', async () => {
    const { deps, calls } = setup({ rows: [row({ date: '2026-11-01' })], events: [event({ date: '2026-11-01', grant: 'SMCTA' })] });
    await sweepTracker(new Date('2026-12-15T16:00:00Z'), deps);
    expect(calls).toEqual(['monday 900', 'saveGrant 900 VTA']);
  });

  it('uses each job’s own start date', async () => {
    const { deps, calls } = setup({ events: [event({ grant: '' })], grants: [] });
    deps.config.attendeeSync.tracker!.startDate = '2026-11-15';
    await sweepTracker(NOW, deps);
    expect(calls).toEqual(['monday 900', 'saveGrant 900 VTA']);
  });
});

describe('sweepTracker failures', () => {
  it('throws on an empty tracker, changing nothing', async () => {
    const { deps, calls } = setup({ rows: [], counts: [ours] });
    await expect(sweepTracker(NOW, deps)).rejects.toThrow('no tracker rows');
    expect(calls).toEqual([]);
  });

  it('leaves a row and its Grant alone when its event wasn’t returned', async () => {
    const { deps, calls } = setup({ rows: [row({ cells: ['3', '1', '1'] })], counts: [ours], events: [] });
    const result = await sweepTracker(NOW, deps);
    expect(calls).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('900')]);
  });

  it('writes nothing at all when a later read fails', async () => {
    const { deps, calls, listItemsLinkedTo } = setup({ rows: [row(), row({ id: '2', link: '901' })], events: [event({ grant: '' }), event({ id: '901' })], grants: [] });
    listItemsLinkedTo.mockResolvedValueOnce(ATTENDED).mockRejectedValueOnce(new Error('Monday down'));
    await expect(sweepTracker(NOW, deps)).rejects.toThrow('Monday down');
    expect(calls).toEqual([]);
  });

  it('goes on after a refused write, records nothing for it, and stops after three in a row', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, store, changeColumnValues } = setup({ rows: ['1', '2', '3', '4', '5', '6'].map((id) => row({ id })) });
    changeColumnValues.mockRejectedValueOnce(new Error('refused')).mockResolvedValueOnce(undefined).mockRejectedValue(new Error('refused'));
    const result = await sweepTracker(NOW, deps);
    expect(result.failed).toEqual(['1', '3', '4', '5']);
    expect(store.saveCounts.mock.calls.map(([r]) => r.trackerItemId)).toEqual(['2']);
    expect(error.mock.calls[0]![0]).toContain('tr_reg_col');
    error.mockRestore();
  });

  it('a refused Grant doesn’t stop the totals', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, changeColumnValues, calls } = setup({ events: [event({ grant: '' })], grants: [] });
    changeColumnValues.mockRejectedValueOnce(new Error('refused'));
    const result = await sweepTracker(NOW, deps);
    expect(result.failed).toEqual(['900']);
    expect(calls).toEqual(['monday 1', 'saveCounts 1']);
    vi.restoreAllMocks();
  });

  it('a dry run counts, and writes neither Monday nor D1', async () => {
    const { deps, calls } = setup({ dryRun: true, rows: [row(), row({ id: '2', link: '', cells: ['3', '1', '1'] })], counts: [{ ...ours, trackerItemId: '2' }], events: [event({ grant: '' })], grants: [] });
    const result = await sweepTracker(NOW, deps);
    expect(calls).toEqual([]);
    expect(result).toEqual({ grants: 1, rows: 1, cleared: 1, failed: [], warnings: [], dryRun: true });
  });
});

describe('logTrackerSummary', () => {
  afterEach(() => vi.restoreAllMocks());

  const result = (over: Partial<TrackerSweepResult> = {}): TrackerSweepResult => ({ grants: 0, rows: 0, cleared: 0, failed: [], warnings: [], dryRun: false, ...over });
  function logged(r: TrackerSweepResult, logWarnings = false) {
    const spies = { log: vi.spyOn(console, 'log'), warn: vi.spyOn(console, 'warn'), error: vi.spyOn(console, 'error') };
    for (const spy of Object.values(spies)) spy.mockImplementation(() => {});
    logTrackerSummary(r, logWarnings);
    return Object.fromEntries(Object.entries(spies).map(([k, spy]) => [k, spy.mock.calls.map(([line]) => line as string)]));
  }

  it('says nothing when nothing changed', () => {
    expect(logged(result())).toEqual({ log: [], warn: [], error: [] });
  });

  it('logs what it wrote, and errors when something failed', () => {
    expect(logged(result({ rows: 2, grants: 1 })).log).toHaveLength(1);
    vi.restoreAllMocks();
    expect(logged(result({ rows: 1, failed: ['1'] })).error).toEqual([expect.stringContaining('1')]);
  });

  it('logs warnings only when asked', () => {
    expect(logged(result({ warnings: ['w'] })).warn).toEqual([]);
    vi.restoreAllMocks();
    expect(logged(result({ warnings: ['w'] }), true).warn).toEqual([expect.stringContaining('w')]);
  });

  it('says a dry run wrote nothing', () => {
    expect(logged(result({ rows: 1, dryRun: true })).log).toEqual([expect.stringContaining('dry run')]);
  });

  it('carries no item names', async () => {
    const { deps } = setup({ rows: [row({ date: '2026-11-13' })], grants: [] });
    expect(JSON.stringify(await sweepTracker(NOW, deps))).not.toContain('Secret');
  });
});
