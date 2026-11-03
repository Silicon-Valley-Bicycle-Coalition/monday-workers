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

// Column types that hold no value of their own, so they have nothing to carry across a move.
// Monday's move_item_to_board maps connect-boards columns itself, by title and matching board
// connection, and refuses them in columns_mapping (community-confirmed; the API docs only say an
// unmapped column "will lose the column's data"), so board_relation is left out of the mapping
// but still checked for parity below.
const VALUELESS_TYPES = new Set(['formula', 'mirror', 'auto_number', 'creation_log', 'last_updated', 'item_id', 'button', 'progress', 'subtasks', 'dependency', 'name']);
const SELF_MAPPED_TYPES = new Set(['board_relation']);

export interface ColumnMapping { source: string; target: string }

export interface ParityResult {
  mapping: ColumnMapping[];
  // Source columns that hold values and have no same-title, same-type column on the target.
  // Any entry blocks the move: Monday would silently drop that column's value.
  missing: { title: string; type: string }[];
}

// Builds the mapping for a move from `source` to `target`. Every value-bearing source column must
// have a same-title, same-type target column; the mapping is exhaustive over those so Monday's
// "best match" guessing never runs. Connect columns are checked but not mapped (see above).
export function moveMapping(source: BoardColumn[], target: BoardColumn[]): ParityResult {
  const targetByKey = new Map(target.map((c) => [`${bareTitle(c.title)}\u0000${c.type}`, c]));
  const mapping: ColumnMapping[] = [];
  const missing: { title: string; type: string }[] = [];
  for (const col of source) {
    if (VALUELESS_TYPES.has(col.type)) continue;
    const match = targetByKey.get(`${bareTitle(col.title)}\u0000${col.type}`);
    if (match === undefined) {
      missing.push({ title: col.title, type: col.type });
      continue;
    }
    if (SELF_MAPPED_TYPES.has(col.type)) continue;
    mapping.push({ source: col.id, target: match.id });
  }
  return { mapping, missing };
}
