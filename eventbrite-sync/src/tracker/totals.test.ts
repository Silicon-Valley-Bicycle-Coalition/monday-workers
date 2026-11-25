import { describe, it, expect } from 'vitest';
import { computeTotals, planRow, type Desired, type RowAction, type TrackerRecord } from './totals';
import type { Totals, TrackerRow } from './types';

describe('computeTotals', () => {
  it('counts cancellations only in Registered, and a blank Attendance as a no-show', () => {
    expect(computeTotals(['Attended', 'Registered', 'Canceled', 'No Show', ''])).toEqual({ registered: 5, checkedIn: 1, noShows: 3 });
  });

  it.each([[['Registered', 'Canceled']], [['No Show']], [[]]])('has no totals when nobody attended: %j', (attendance) => {
    expect(computeTotals(attendance)).toBeNull();
  });
});

const t = (registered: number, checkedIn: number, noShows: number): Totals => ({ registered, checkedIn, noShows });
const cells = (registered: number | null, checkedIn: number | null, noShows: number | null): TrackerRow['cells'] => ({ registered, checkedIn, noShows });
const BLANK = cells(null, null, null);
const OURS = cells(5, 1, 3);
const recordA: TrackerRecord = { trackerItemId: '1', eventItemId: 'A', date: '2026-11-14', totals: t(5, 1, 3) };
const totals = (eventItemId: string, value: Totals): Desired => ({ kind: 'totals', eventItemId, totals: value });
const write = (eventItemId: string, value: Totals): RowAction => ({ kind: 'write', eventItemId, totals: value });
const NONE: Desired = { kind: 'none' };
const NOTHING: RowAction = { kind: 'nothing' };
const CLEAR: RowAction = { kind: 'clear' };

describe('planRow', () => {
  it.each<[string, TrackerRow['cells'], TrackerRecord | null, Desired, RowAction]>([
    ['writes a blank row', BLANK, null, totals('A', t(5, 1, 3)), write('A', t(5, 1, 3))],
    ['writes new totals over its own', OURS, recordA, totals('A', t(5, 2, 2)), write('A', t(5, 2, 2))],
    ['leaves unchanged totals', OURS, recordA, totals('A', t(5, 1, 3)), NOTHING],
    ['records a relink whose totals happen to match', OURS, recordA, totals('B', t(5, 1, 3)), { kind: 'remember', eventItemId: 'B', totals: t(5, 1, 3) }],
    ['refills a cell someone cleared', cells(5, null, 3), recordA, totals('A', t(5, 1, 3)), write('A', t(5, 1, 3))],
    ['leaves the whole row once one cell is a person’s', cells(5, 2, 3), recordA, totals('A', t(6, 1, 4)), NOTHING],
    ['treats a typed 0 as a person’s', cells(null, 0, null), null, totals('A', t(5, 1, 3)), NOTHING],
    ['leaves typed totals, even matching ones', OURS, null, totals('A', t(5, 1, 3)), NOTHING],
    ['clears its own when the row stops having totals', OURS, recordA, NONE, CLEAR],
    ['leaves a person’s row that stops having totals', cells(5, 2, 3), recordA, NONE, NOTHING],
    ['drops the record of a row someone emptied', BLANK, recordA, NONE, { kind: 'forget' }],
    ['leaves a blank row with no totals', BLANK, null, NONE, NOTHING],
    ['holds its own while the feed settles', OURS, recordA, { kind: 'hold', eventItemId: 'A' }, NOTHING],
    ['clears the old class’s totals while the new class’s feed settles', OURS, recordA, { kind: 'hold', eventItemId: 'B' }, CLEAR],
    ['leaves a blank row while the feed settles', BLANK, null, { kind: 'hold', eventItemId: 'A' }, NOTHING],
    ['leaves a person’s relinked row while the feed settles', cells(5, 2, 3), recordA, { kind: 'hold', eventItemId: 'B' }, NOTHING],
    ['changes nothing when the event is unknown', OURS, recordA, { kind: 'unknown' }, NOTHING],
  ])('%s', (_name, current, record, desired, action) => {
    expect(planRow(current, record, desired, false)).toEqual(action);
  });

  it.each<[string, TrackerRow['cells'], TrackerRecord | null, Desired]>([
    ['never clears', OURS, recordA, NONE],
    ['never writes', BLANK, null, totals('A', t(5, 1, 3))],
    ['never updates', OURS, recordA, totals('A', t(5, 2, 2))],
  ])('%s a frozen row', (_name, current, record, desired) => {
    expect(planRow(current, record, desired, true)).toEqual(NOTHING);
  });
});
