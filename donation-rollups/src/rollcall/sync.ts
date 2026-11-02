// The Donor Roll Call board's diff (spec 2026-11-02 §5 step 5): match the board's items to the
// computed rows by Row Key, then create, update, move or delete only what differs. A staff-
// printed board, so the rule throughout is that an unchanged row produces no op at all, and a
// closed year's row is deleted only when the computation positively replaced it.
import { formatCents, parseAmountCents } from '../money';
import { statusLabel, type ItemColumns } from '../monday/client';
import type { CustodianDeps } from '../custodian/custodian';
import type { RollCallConfig } from '../types';
import type { RollCallRow } from './compute';

type Columns = RollCallConfig['columns'];

// One board item as planSync compares it: the board's text per column, except status columns
// (their label, read by stored value) and connect columns (linked item ids, sorted, comma-joined).
// Build it with boardItemFrom.
export interface BoardItem { id: string; name: string; groupId: string; cells: Map<string, string | null> }

export type SyncOp = { op: 'create'; row: RollCallRow } | { op: 'update'; itemId: string; row: RollCallRow; values: Record<string, unknown> }
  | { op: 'move'; itemId: string; fiscalYear: number } | { op: 'delete'; itemId: string; reason: 'gone' | 'duplicate' };

const STATUS = ['tier', 'type', 'listed'] as const;
const CONNECT = ['people', 'organization'] as const;

export function boardItemFrom(item: ItemColumns, cols: Columns): BoardItem {
  const cells = new Map(item.text);
  for (const c of STATUS) if (cells.has(cols[c])) cells.set(cols[c], statusLabel(item.text.get(cols[c]), item.values.get(cols[c])));
  for (const c of CONNECT) {
    if (!cells.has(cols[c])) continue;
    const ids = [...(item.linkedIds?.get(cols[c]) ?? [])].sort();
    cells.set(cols[c], ids.length ? ids.join(',') : null);
  }
  return { id: item.id, name: item.name ?? '', groupId: item.groupId ?? '', cells };
}

// "FY2026" or "FY2026 (in progress)" -> 2026; any other title is a group this duty doesn't own.
export function groupYearFrom(title: string): number | null {
  const m = /^FY(\d{4})(?: \(in progress\))?$/.exec(title.trim());
  return m ? Number(m[1]) : null;
}

export function groupTitle(fiscalYear: number, currentFY: number): string {
  return fiscalYear === currentFY ? `FY${fiscalYear} (in progress)` : `FY${fiscalYear}`;
}

const itemIds = (ids: string[]): { item_ids: number[] } => ({ item_ids: ids.map(Number) });

export function columnValuesFor(row: RollCallRow, cols: Columns): Record<string, unknown> {
  return {
    [cols.fiscalYear]: String(row.fiscalYear),
    [cols.tier]: { label: row.tier },
    [cols.type]: { label: row.type },
    [cols.listed]: { label: row.listed },
    [cols.total]: formatCents(row.totalCents),
    [cols.gifts]: String(row.gifts),
    [cols.people]: itemIds(row.personIds),
    [cols.organization]: itemIds(row.organizationId === null ? [] : [row.organizationId]),
    [cols.reviewNote]: { text: row.reviewNote },
    [cols.rowKey]: row.key,
  };
}

// Each column's cell in one comparable form, from the row and from the board, so an unchanged
// row compares equal however Monday renders it: numbers to the cent ("$1,250.5" == 1250.50),
// connect ids as a sorted set, text trimmed, blank as null.
const blank = (s: string | null | undefined): string | null => (s === null || s === undefined || s.trim() === '' ? null : s.trim());
const number = (s: string | null | undefined): string | null => {
  const cents = parseAmountCents(blank(s));
  return cents === null ? blank(s) : formatCents(cents);
};
const idSet = (s: string | null | undefined): string | null =>
  blank(s) === null ? null : s!.split(',').map((id) => id.trim()).filter(Boolean).sort().join(',') || null;

function expectedCells(row: RollCallRow, cols: Columns): [keyof Columns, string | null][] {
  return [
    ['fiscalYear', String(row.fiscalYear)],
    ['tier', row.tier], ['type', row.type], ['listed', row.listed],
    ['total', formatCents(row.totalCents)],
    ['gifts', formatCents(row.gifts * 100)],
    ['people', idSet(row.personIds.join(','))],
    ['organization', row.organizationId],
    ['reviewNote', blank(row.reviewNote)],
  ];
}

function boardCell(item: BoardItem, cols: Columns, col: keyof Columns): string | null {
  const raw = item.cells.get(cols[col]);
  if (col === 'total' || col === 'gifts') return number(raw);
  if (col === 'people' || col === 'organization') return idSet(raw);
  return blank(raw);
}

// A Row Key's fiscal year, or null for a key this duty didn't write (blank or hand-typed), which
// planSync leaves alone rather than deleting.
const keyYear = (key: string | null): number | null => {
  const m = key === null ? null : /^(\d{4})\|./.exec(key);
  return m ? Number(m[1]) : null;
};

export function planSync(rows: RollCallRow[], items: BoardItem[], cols: Columns,
  frozenYears: Set<number>, groupYearById: Map<string, number>): SyncOp[] {
  const deletes: SyncOp[] = [];
  const updates: SyncOp[] = [];
  const moves: SyncOp[] = [];
  const creates: SyncOp[] = [];

  const byKey = new Map<string, BoardItem[]>();
  for (const item of items) {
    const key = blank(item.cells.get(cols.rowKey));
    if (key === null || keyYear(key) === null) continue;
    let list = byKey.get(key);
    if (list === undefined) byKey.set(key, list = []);
    list.push(item);
  }
  // Keep the lowest item id per key (ids compare as numbers); the rest are duplicates, frozen
  // year or not — a duplicate prints the donor twice.
  const kept = new Map<string, BoardItem>();
  for (const [key, list] of byKey) {
    list.sort((a, b) => Number(a.id) - Number(b.id));
    kept.set(key, list[0]!);
    for (const dup of list.slice(1)) deletes.push({ op: 'delete', itemId: dup.id, reason: 'duplicate' });
  }

  const rowKeys = new Set<string>();
  for (const row of rows) {
    rowKeys.add(row.key);
    const item = kept.get(row.key);
    if (item === undefined) {
      creates.push({ op: 'create', row });
      continue;
    }
    const all = columnValuesFor(row, cols);
    const values: Record<string, unknown> = {};
    if (item.name !== row.name) values.name = row.name;
    for (const [col, want] of expectedCells(row, cols)) {
      if (boardCell(item, cols, col) !== want) values[cols[col]] = all[cols[col]];
    }
    if (Object.keys(values).length) updates.push({ op: 'update', itemId: item.id, row, values });
    if (groupYearById.get(item.groupId) !== row.fiscalYear) moves.push({ op: 'move', itemId: item.id, fiscalYear: row.fiscalYear });
  }

  // A frozen (closed, fully archived) year's row goes only when one of its donors is on a
  // different computed row that year — a household join, say. A donor who simply vanished from
  // the inputs keeps the row as printed.
  const donorsByYear = new Map<number, Set<string>>();
  for (const row of rows) {
    let ids = donorsByYear.get(row.fiscalYear);
    if (ids === undefined) donorsByYear.set(row.fiscalYear, ids = new Set());
    for (const id of row.personIds) ids.add(id);
    if (row.organizationId !== null) ids.add(row.organizationId);
  }
  for (const [key, item] of kept) {
    if (rowKeys.has(key)) continue;
    const year = keyYear(key)!;
    if (frozenYears.has(year)) {
      const donors = donorsByYear.get(year);
      const ids = [idSet(item.cells.get(cols.people)), idSet(item.cells.get(cols.organization))]
        .flatMap((s) => (s === null ? [] : s.split(',')));
      if (!ids.some((id) => donors?.has(id))) continue;
    }
    deletes.push({ op: 'delete', itemId: item.id, reason: 'gone' });
  }
  return [...deletes, ...updates, ...moves, ...creates];
}

const ORDER: Record<SyncOp['op'], number> = { delete: 0, update: 1, move: 2, create: 3 };

// Year groups first (create a missing one; retitle so only the current year reads "(in
// progress)"), then deletes, updates, moves and creates. Every write counts against
// writesPerRun; what's left over is reported as `remaining` for the next run.
export async function applySync(deps: CustodianDeps, cfg: RollCallConfig, ops: SyncOp[], currentFY: number):
  Promise<{ applied: number; remaining: number }> {
  const client = deps.mondayClient;
  const groupByYear = new Map<number, string>();
  const retitles: { id: string; title: string }[] = [];
  for (const g of await client.listGroups(cfg.boardId)) {
    const year = groupYearFrom(g.title);
    if (year === null) continue;
    if (!groupByYear.has(year)) groupByYear.set(year, g.id);
    if (g.title !== groupTitle(year, currentFY)) retitles.push({ id: g.id, title: groupTitle(year, currentFY) });
  }
  const neededYears = new Set<number>([currentFY]);
  for (const op of ops) {
    if (op.op === 'create') neededYears.add(op.row.fiscalYear);
    if (op.op === 'move') neededYears.add(op.fiscalYear);
  }
  const missingYears = [...neededYears].filter((y) => !groupByYear.has(y)).sort((a, b) => a - b);

  const sorted = [...ops].sort((a, b) => ORDER[a.op] - ORDER[b.op]);
  const total = missingYears.length + retitles.length + sorted.length;
  let applied = 0;
  const done = () => ({ applied, remaining: total - applied });

  // Oldest first, so the newest year's group, created last, sits on top.
  for (const year of missingYears) {
    if (applied >= cfg.writesPerRun) return done();
    groupByYear.set(year, await client.createGroup(cfg.boardId, groupTitle(year, currentFY)));
    applied++;
  }
  for (const r of retitles) {
    if (applied >= cfg.writesPerRun) return done();
    await client.updateGroupTitle(cfg.boardId, r.id, r.title);
    applied++;
  }
  for (const op of sorted) {
    if (applied >= cfg.writesPerRun) return done();
    if (op.op === 'delete') await client.deleteItem(op.itemId);
    else if (op.op === 'update') await client.changeColumnValues(cfg.boardId, op.itemId, op.values);
    else if (op.op === 'move') await client.moveItemToGroup(op.itemId, groupByYear.get(op.fiscalYear)!);
    else await client.createItemInGroup(cfg.boardId, groupByYear.get(op.row.fiscalYear)!, op.row.name, columnValuesFor(op.row, cfg.columns));
    applied++;
  }
  return done();
}
