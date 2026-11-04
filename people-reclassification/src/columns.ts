// Column resolution by title, and the explicit columns_mapping a move needs.
//
// Why titles: the two People boards are created by salesforce-import from one column spec, so
// their titles agree while their ids differ per board (donation-rollups' config carries three
// separately generated id sets for the same twelve rollup columns for exactly this reason).
// Resolving once per pass from `boards { columns { id title type } }` also gives the move its
// mapping for free — and a title missing on either board fails the pass before anything moves.
// Titles compare without their read-only marker (🔒/📜, scripts/lib/column-titles.mjs), so config
// names the bare title and a marker on one board but not the other never blocks a move.

import { bareTitle } from '../../scripts/lib/column-titles.mjs';

export interface BoardColumn { id: string; title: string; type: string }

export class ColumnLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ColumnLookupError';
  }
}

export function columnIdByTitle(columns: BoardColumn[], title: string, boardLabel: string): string {
  const matches = columns.filter((c) => bareTitle(c.title) === bareTitle(title));
  if (matches.length === 0) throw new ColumnLookupError(`${boardLabel}: no column titled "${title}"`);
  if (matches.length > 1) throw new ColumnLookupError(`${boardLabel}: ${matches.length} columns titled "${title}" — rename one`);
  return matches[0]!.id;
}

// Column types that hold no value of their own, so they have nothing to carry across a move: one
// missing on the target is no reason to block the move.
const VALUELESS_TYPES = new Set(['formula', 'mirror', 'auto_number', 'creation_log', 'last_updated', 'item_id', 'button', 'progress', 'subtasks', 'dependency', 'name']);

// target null drops that column's data on the move (Monday's documented way to leave one out).
export interface ColumnMapping { source: string; target: string | null }

export interface ParityResult {
  mapping: ColumnMapping[];
  // Source columns that hold values and have no same-title, same-type column on the target.
  // Any entry blocks the move: Monday would silently drop that column's value.
  missing: { title: string; type: string }[];
}

// Builds the mapping for a move from `source` to `target`. Probed against sandbox v4 on
// 2026-11-02: when columns_mapping is given, Monday needs an entry for every source column except
// the name column, and answers "Columns mapping is not in the expected format" to one that omits
// a column or includes the name (the older community advice to leave connect columns out was
// wrong); a null target is accepted and drops that column. So each column but the name maps to
// the same-title, same-type target column, else to null; formula columns can't be mapped, so
// they are always null. Every value-bearing column must have a match, or the move is blocked.
export function moveMapping(source: BoardColumn[], target: BoardColumn[]): ParityResult {
  const targetByKey = new Map(target.map((c) => [`${bareTitle(c.title)}\u0000${c.type}`, c]));
  const mapping: ColumnMapping[] = [];
  const missing: { title: string; type: string }[] = [];
  for (const col of source) {
    if (col.type === 'name') continue;   // the item name always travels with the item
    const match = col.type === 'formula' ? undefined : targetByKey.get(`${bareTitle(col.title)}\u0000${col.type}`);
    if (match === undefined && !VALUELESS_TYPES.has(col.type)) missing.push({ title: col.title, type: col.type });
    mapping.push({ source: col.id, target: match?.id ?? null });
  }
  return { mapping, missing };
}
