import type { ColumnDef, ColumnValue } from '../types';

// Converts snapshot column values (what Monday's read API returned) into what its write API
// accepts (change_multiple_column_values / create_item `column_values`). The read `value` is
// usually close to the write shape but carries read-only extras (changed_at, post_id, …) that
// some column types reject, so known types are rebuilt explicitly.

// Never written: computed, system-maintained, or restored some other way.
export const NOT_WRITABLE = new Set([
  'name', // the item name, passed separately
  'subtasks', // subitems are created with create_subitem
  'mirror', // derived from a connect-boards column
  'formula',
  'auto_number',
  'creation_log',
  'last_updated',
  'item_id',
  'button',
  'progress',
  'file', // files are not restored — see RESTORE.md
  'doc',
  'direct_doc',
  'vote',
  'time_tracking',
]);

// Written in a second pass, once every item exists and old item ids can be mapped to new ones.
export const RELATION_TYPES = new Set(['board_relation', 'dependency']);

function parse(value: string | null): Record<string, unknown> | null {
  if (value === null || value === '') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pick(obj: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (obj[key] !== undefined && obj[key] !== null) out[key] = obj[key];
  return Object.keys(out).length > 0 ? out : undefined;
}

// Returns the value to write for a non-relation column, or undefined to leave it empty.
export function writableValue(column: ColumnDef, cv: ColumnValue): unknown {
  const type = column.type;
  if (NOT_WRITABLE.has(type) || RELATION_TYPES.has(type)) return undefined;
  const text = cv.text ?? '';
  const value = parse(cv.value);

  switch (type) {
    case 'text':
      return text === '' ? undefined : text;
    case 'numbers':
      return text === '' ? undefined : text;
    case 'long_text':
      return text === '' ? undefined : { text };
    // Labels by text, not index: the restored column's label indexes may differ, and
    // create_labels_if_missing recreates any label the column doesn't have yet.
    case 'status':
      return text === '' ? undefined : { label: text };
    case 'dropdown':
      return text === '' ? undefined : { labels: text.split(', ') };
    case 'date':
      return value ? pick(value, 'date', 'time') : undefined;
    case 'timeline':
      return value ? pick(value, 'from', 'to') : undefined;
    case 'email':
      return value ? pick(value, 'email', 'text') : undefined;
    case 'phone':
      return value ? pick(value, 'phone', 'countryShortName') : undefined;
    case 'link':
      return value ? pick(value, 'url', 'text') : undefined;
    case 'checkbox':
      return value?.checked === true || value?.checked === 'true' ? { checked: 'true' } : undefined;
    case 'rating':
      return value ? pick(value, 'rating') : undefined;
    case 'hour':
      return value ? pick(value, 'hour', 'minute') : undefined;
    case 'week':
      return value ? pick(value, 'week') : undefined;
    case 'country':
      return value ? pick(value, 'countryCode', 'countryName') : undefined;
    case 'location':
      return value ? pick(value, 'lat', 'lng', 'address') : undefined;
    case 'world_clock':
      return value ? pick(value, 'timezone') : undefined;
    // People and tags keep account-level ids, valid when restoring into the same account.
    case 'people':
      return value ? pick(value, 'personsAndTeams') : undefined;
    case 'tags':
      return value ? pick(value, 'tag_ids') : undefined;
    default:
      // Unknown or newer column type: hand back what was read and let Monday validate it. A
      // rejection makes the restore retry the item without its column values and report it.
      return value ?? undefined;
  }
}

// The second-pass value for a connect-boards/dependency column, with linked ids mapped to the
// restored items. Links to items that weren't restored are dropped and reported by the caller.
export function relationValue(cv: ColumnValue, mapItem: (oldId: string) => string | undefined): { value: unknown; dropped: string[] } | undefined {
  const linked = cv.linkedItemIds ?? [];
  if (linked.length === 0) return undefined;
  const mapped: number[] = [];
  const dropped: string[] = [];
  for (const oldId of linked) {
    const newId = mapItem(oldId);
    if (newId === undefined) dropped.push(oldId);
    else mapped.push(Number(newId));
  }
  if (mapped.length === 0) return { value: undefined, dropped };
  return { value: { item_ids: mapped }, dropped };
}
