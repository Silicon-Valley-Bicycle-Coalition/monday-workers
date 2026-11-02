import { describe, it, expect } from 'vitest';
import { applySync, boardItemFrom, columnValuesFor, groupTitle, groupYearFrom, planSync, type BoardItem, type SyncOp } from './sync';
import type { RollCallRow } from './compute';
import type { CustodianDeps } from '../custodian/custodian';
import type { RollCallConfig } from '../types';

const COLS: RollCallConfig['columns'] = {
  fiscalYear: 'fy', tier: 'tier', type: 'type', listed: 'listed', total: 'total', gifts: 'gifts',
  people: 'people', organization: 'org', reviewNote: 'note', rowKey: 'key',
};
const GROUPS = new Map([['g26', 2026], ['g27', 2027]]);

function row(over: Partial<RollCallRow> & { key: string }): RollCallRow {
  return { fiscalYear: Number(over.key.slice(0, 4)), name: 'Ada Lovelace', tier: '$1,000+', type: 'Individual', listed: 'Listed',
    totalCents: 125050, gifts: 3, personIds: ['101'], organizationId: null, reviewNote: '', ...over };
}

// The row as pageItemsColumnsText + boardItemFrom would read it back: Monday's own number text,
// the people linked in whatever order the board returns them.
function itemFor(r: RollCallRow, id: string, cells: Record<string, string | null> = {}): BoardItem {
  return { id, name: r.name, groupId: r.fiscalYear === 2026 ? 'g26' : 'g27', cells: new Map(Object.entries({
    fy: String(r.fiscalYear), tier: r.tier, type: r.type, listed: r.listed, total: (r.totalCents / 100).toString(), gifts: String(r.gifts),
    people: [...r.personIds].reverse().join(',') || null, org: r.organizationId, note: r.reviewNote || null, key: r.key, ...cells,
  })) };
}

describe('columnValuesFor', () => {
  it('writes status labels, connect ids, dollars from cents, long text and the key', () => {
    expect(columnValuesFor(row({ key: '2026|household:H1', personIds: ['101', '102'], type: 'Household', reviewNote: 'check' }), COLS)).toEqual({
      fy: '2026', tier: { label: '$1,000+' }, type: { label: 'Household' }, listed: { label: 'Listed' },
      total: '1250.50', gifts: '3', people: { item_ids: [101, 102] }, org: { item_ids: [] },
      note: { text: 'check' }, key: '2026|household:H1',
    });
  });
});

describe('boardItemFrom', () => {
  it('reads statuses by stored value and connect columns as sorted linked ids', () => {
    const item = boardItemFrom({
      id: '7', name: 'Ada', groupId: 'g26',
      text: new Map<string, string | null>([['tier', '$100+'], ['type', 'Individual'], ['people', 'Bo, Ada'], ['org', null], ['total', '$1,250.5']]),
      values: new Map<string, string | null>([['tier', '{"index":1}'], ['type', null], ['people', '{}'], ['org', null], ['total', '"1250.5"']]),
      linkedIds: new Map([['people', ['102', '101']], ['org', []]]),
    }, COLS);
    expect(item).toEqual({ id: '7', name: 'Ada', groupId: 'g26', cells: new Map<string, string | null>([
      ['tier', '$100+'], ['type', null], ['people', '101,102'], ['org', null], ['total', '$1,250.5']]) });
  });
});

describe('group titles', () => {
  it('parses FY<year> with or without (in progress), and nothing else', () => {
    expect(groupYearFrom('FY2026')).toBe(2026);
    expect(groupYearFrom('FY2027 (in progress)')).toBe(2027);
    expect(groupYearFrom('Group Title')).toBeNull();
    expect(groupYearFrom('FY2026 notes')).toBeNull();
    expect(groupTitle(2027, 2027)).toBe('FY2027 (in progress)');
    expect(groupTitle(2026, 2027)).toBe('FY2026');
  });
});

describe('planSync', () => {
  it('an identical board gives no ops', () => {
    const rows = [row({ key: '2027|item:101' }), row({ key: '2026|household:H1', type: 'Household', personIds: ['101', '102'], reviewNote: 'x' }),
      row({ key: '2026|item:201', type: 'Organization', personIds: [], organizationId: '201' })];
    expect(planSync(rows, rows.map((r, i) => itemFor(r, String(i + 1))), COLS, new Set(), GROUPS)).toEqual([]);
  });

  it('reads Monday\'s currency text numerically and the review note trimmed', () => {
    const r = row({ key: '2027|item:101', reviewNote: 'check' });
    expect(planSync([r], [itemFor(r, '1', { total: '$1,250.50', note: ' check\n' })], COLS, new Set(), GROUPS)).toEqual([]);
  });

  it('a changed total updates only total, plus tier when it moved', () => {
    const before = row({ key: '2027|item:101' });
    const same = { ...before, totalCents: 130000 };
    const up = { ...before, totalCents: 260000, tier: '$2,500+' };
    expect(planSync([same], [itemFor(before, '1')], COLS, new Set(), GROUPS))
      .toEqual([{ op: 'update', itemId: '1', row: same, values: { total: '1300.00' } }]);
    expect(planSync([up], [itemFor(before, '1')], COLS, new Set(), GROUPS))
      .toEqual([{ op: 'update', itemId: '1', row: up, values: { tier: { label: '$2,500+' }, total: '2600.00' } }]);
  });

  it('a renamed donor updates the name', () => {
    const r = row({ key: '2027|item:101' });
    expect(planSync([{ ...r, name: 'Ada King' }], [itemFor(r, '1')], COLS, new Set(), GROUPS))
      .toEqual([{ op: 'update', itemId: '1', row: { ...r, name: 'Ada King' }, values: { name: 'Ada King' } }]);
  });

  it('a missing row is created', () => {
    const r = row({ key: '2027|item:101' });
    expect(planSync([r], [], COLS, new Set(), GROUPS)).toEqual([{ op: 'create', row: r }]);
  });

  it('Review Focus 1: two Individual items joined into one Household in a frozen year are deleted and the household created', () => {
    const household = row({ key: '2026|household:H1', type: 'Household', personIds: ['101', '102'], totalCents: 300000, tier: '$2,500+' });
    const items = [itemFor(row({ key: '2026|item:101', personIds: ['101'] }), '1'), itemFor(row({ key: '2026|item:102', personIds: ['102'] }), '2')];
    expect(planSync([household], items, COLS, new Set([2026]), GROUPS)).toEqual([
      { op: 'delete', itemId: '1', reason: 'gone' }, { op: 'delete', itemId: '2', reason: 'gone' }, { op: 'create', row: household }]);
  });

  it('keeps a frozen year\'s item whose donor is in no row of that year', () => {
    const items = [itemFor(row({ key: '2026|item:109', personIds: ['109'] }), '1'),
      itemFor(row({ key: '2026|item:209', personIds: [], organizationId: '209', type: 'Organization' }), '2'),
      itemFor(row({ key: '2026|anonymous', personIds: [], name: 'Anonymous', type: 'Anonymous' }), '3')];
    // 109 gives in 2027, which doesn't count for 2026.
    const rows = [row({ key: '2026|item:101' }), row({ key: '2027|item:109', personIds: ['109'] })];
    const ops = planSync(rows, [...items, itemFor(rows[0]!, '4'), itemFor(rows[1]!, '5')], COLS, new Set([2026]), GROUPS);
    expect(ops).toEqual([]);
  });

  it('a frozen year\'s organization item is deleted when that organization is on another row that year', () => {
    const items = [itemFor(row({ key: '2026|item:209', personIds: [], organizationId: '209', type: 'Organization' }), '1')];
    const rows = [row({ key: '2026|household:H9', personIds: [], organizationId: '209', type: 'Organization' })];
    expect(planSync(rows, items, COLS, new Set([2026]), GROUPS)).toEqual([
      { op: 'delete', itemId: '1', reason: 'gone' }, { op: 'create', row: rows[0] }]);
  });

  it('an open year\'s item whose key is no longer computed is deleted', () => {
    expect(planSync([], [itemFor(row({ key: '2027|item:109', personIds: ['109'] }), '1')], COLS, new Set([2026]), GROUPS))
      .toEqual([{ op: 'delete', itemId: '1', reason: 'gone' }]);
  });

  it('leaves alone an item with no Row Key, or one that isn\'t <year>|…', () => {
    const items = [itemFor(row({ key: '2027|item:101' }), '1', { key: null }), itemFor(row({ key: '2027|item:101' }), '2', { key: 'hand made' })];
    expect(planSync([], items, COLS, new Set(), GROUPS)).toEqual([]);
  });

  it('Review Focus 2: two items with one key delete the higher id as a duplicate and create nothing', () => {
    const r = row({ key: '2027|item:101' });
    // Ids compare as numbers: 99 is the lower, though "105" sorts first as a string.
    expect(planSync([r], [itemFor(r, '105'), itemFor(r, '99')], COLS, new Set(), GROUPS))
      .toEqual([{ op: 'delete', itemId: '105', reason: 'duplicate' }]);
  });

  it('a board read that repeats an item (a paging race) gives no ops for an unchanged row', () => {
    const r = row({ key: '2027|item:101' });
    expect(planSync([r], [itemFor(r, '7'), itemFor(r, '7')], COLS, new Set(), GROUPS)).toEqual([]);
    // Repeated and genuinely duplicated: only the other id goes.
    expect(planSync([r], [itemFor(r, '7'), itemFor(r, '9'), itemFor(r, '7')], COLS, new Set(), GROUPS))
      .toEqual([{ op: 'delete', itemId: '9', reason: 'duplicate' }]);
    // A repeated item that is gone is deleted once.
    expect(planSync([], [itemFor(r, '7'), itemFor(r, '7')], COLS, new Set(), GROUPS))
      .toEqual([{ op: 'delete', itemId: '7', reason: 'gone' }]);
  });

  it('a duplicate in a frozen year is still deleted', () => {
    const r = row({ key: '2026|item:109', personIds: ['109'] });
    expect(planSync([], [itemFor(r, '1'), itemFor(r, '2')], COLS, new Set([2026]), GROUPS))
      .toEqual([{ op: 'delete', itemId: '2', reason: 'duplicate' }]);
  });

  it('an item in the wrong year group moves', () => {
    const r = row({ key: '2027|item:101' });
    expect(planSync([r], [{ ...itemFor(r, '1'), groupId: 'g26' }], COLS, new Set(), GROUPS))
      .toEqual([{ op: 'move', itemId: '1', fiscalYear: 2027 }]);
    expect(planSync([r], [{ ...itemFor(r, '1'), groupId: 'topics' }], COLS, new Set(), GROUPS))
      .toEqual([{ op: 'move', itemId: '1', fiscalYear: 2027 }]);
  });
});

describe('applySync', () => {
  const CFG = { boardId: 5, writesPerRun: 4, columns: COLS } as RollCallConfig;

  function fake(groups: { id: string; title: string }[]) {
    const calls: unknown[][] = [];
    let n = 0;
    const mondayClient = {
      async listGroups(boardId: number) { calls.push(['listGroups', boardId]); return groups; },
      async createGroup(boardId: number, title: string) { calls.push(['createGroup', boardId, title]); return `new-${++n}`; },
      async updateGroupTitle(boardId: number, groupId: string, title: string) { calls.push(['updateGroupTitle', boardId, groupId, title]); },
      async createItemInGroup(boardId: number, groupId: string, name: string, values: Record<string, unknown>) {
        calls.push(['createItemInGroup', boardId, groupId, name, values]); return `item-${++n}`;
      },
      async moveItemToGroup(itemId: string, groupId: string) { calls.push(['moveItemToGroup', itemId, groupId]); },
      async deleteItem(itemId: string) { calls.push(['deleteItem', itemId]); },
      async changeColumnValues(boardId: number, itemId: string, values: Record<string, unknown>) { calls.push(['changeColumnValues', boardId, itemId, values]); },
    };
    return { deps: { mondayClient } as unknown as CustodianDeps, calls: () => calls.filter((c) => c[0] !== 'listGroups') };
  }

  it('applies deletes, updates, moves then creates, and stops at writesPerRun', async () => {
    const r = row({ key: '2027|item:101' });
    const ops: SyncOp[] = [
      { op: 'create', row: r }, { op: 'move', itemId: '3', fiscalYear: 2027 },
      { op: 'update', itemId: '2', row: r, values: { total: '1.00' } }, { op: 'delete', itemId: '1', reason: 'gone' },
      { op: 'create', row: { ...r, key: '2027|item:102' } },
    ];
    const { deps, calls } = fake([{ id: 'g27', title: 'FY2027 (in progress)' }]);
    expect(await applySync(deps, CFG, ops, 2027)).toEqual({ applied: 4, remaining: 1 });
    expect(calls()).toEqual([
      ['deleteItem', '1'], ['changeColumnValues', 5, '2', { total: '1.00' }], ['moveItemToGroup', '3', 'g27'],
      ['createItemInGroup', 5, 'g27', 'Ada Lovelace', columnValuesFor(r, COLS)]]);
  });

  it('creates a missing year group, and retitles a closed one, before the items that go in it', async () => {
    const r = row({ key: '2027|item:101' });
    const { deps, calls } = fake([{ id: 'g26', title: 'FY2026 (in progress)' }, { id: 'topics', title: 'Group Title' }]);
    expect(await applySync(deps, { ...CFG, writesPerRun: 10 }, [{ op: 'create', row: r }], 2027)).toEqual({ applied: 3, remaining: 0 });
    expect(calls()).toEqual([
      ['createGroup', 5, 'FY2027 (in progress)'], ['updateGroupTitle', 5, 'g26', 'FY2026'],
      ['createItemInGroup', 5, 'new-1', 'Ada Lovelace', columnValuesFor(r, COLS)]]);
  });

  it('group writes count against writesPerRun too', async () => {
    const r = row({ key: '2027|item:101' });
    const { deps, calls } = fake([]);
    expect(await applySync(deps, { ...CFG, writesPerRun: 1 }, [{ op: 'create', row: r }], 2027)).toEqual({ applied: 1, remaining: 1 });
    expect(calls()).toEqual([['createGroup', 5, 'FY2027 (in progress)']]);
  });

  it('an already-right board writes nothing', async () => {
    const { deps, calls } = fake([{ id: 'g27', title: 'FY2027 (in progress)' }, { id: 'g26', title: 'FY2026' }]);
    expect(await applySync(deps, CFG, [], 2027)).toEqual({ applied: 0, remaining: 0 });
    expect(calls()).toEqual([]);
  });
});
