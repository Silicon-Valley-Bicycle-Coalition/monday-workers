// Logic for moving purchased wealth-screening (Windfall) data off the two Monday People boards
// onto a private board, and for proving the copy is complete before the source columns are deleted.
//
// Pure and dependency-free: the operator script does the Monday calls. A false "clean" from
// reconcile() loses data, so every doubtful case here fails toward "mismatch". Windfall values
// never leave this module except as write payloads: results and reports hold counts, Monday ids
// and column titles only, and errors never quote a value.

import { bareTitle } from './column-titles.mjs';

export const WINDFALL_TITLES = [
  'Windfall ID',
  'Net Worth',
  'Net Worth Low',
  'Net Worth High',
  'Net Worth Date',
  'Philanthropic Giver',
  'Job Title',
  'Windfall Company',
  'LinkedIn',
  'Windfall Priority',
  'Windfall Profile',
];

// SVBC Integration, Sandbox Integration: must never be on the private board's subscribers.
export const FORBIDDEN_USERS = ['120827741', '117112617'];

const PROFILE_TITLE = 'Windfall Profile';
const REMOVED_FLAGS = ['recently divorced', 'recent death in family'];

// The check on the scrubber, so deliberately not built from it: these words anywhere in a profile,
// in any line or separator. A flag scrubProfile() misses still fails here.
const REMOVED_FLAG_TEXT = /recently\s+divorced|recent\s+death\s+in\s+family/i;

const flagKey = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Drop the removed flags from the `Flags:` line of a profile. Only a line starting `Flags:`
 * (any case) is touched: its entries are trimmed, the removed ones dropped, and the rest rejoined
 * as `Flags: a, b`. A line left with no entries is dropped. Every other line, and each line
 * ending (\n or \r\n), is kept byte for byte.
 */
export function scrubProfile(text) {
  const parts = text.split(/(\r\n|\n|\r)/); // even = line, odd = its ending
  for (let i = 0; i < parts.length; i += 2) {
    const m = /^\s*flags\s*:(.*)$/is.exec(parts[i]);
    if (!m) continue;
    const kept = m[1]
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e !== '' && !REMOVED_FLAGS.includes(flagKey(e)));
    if (kept.length > 0) {
      parts[i] = `Flags: ${kept.join(', ')}`;
    } else if (i + 1 < parts.length) {
      parts.splice(i, 2); // the line and the ending after it
      i -= 2;
    } else if (i > 0) {
      parts.splice(i - 1, 2); // last line: the ending before it, and the line
      i -= 2;
    } else {
      parts[i] = '';
    }
  }
  return parts.join('');
}

function parse(raw) {
  try {
    return { ok: true, v: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = stable(v[k]);
    return out;
  }
  return v;
}

const withoutChangedAt = (o) => {
  const { changed_at: _drop, ...rest } = o;
  return rest;
};

// A plain object whose keys, apart from changed_at, are all in `known`. Anything else (an array,
// an unfamiliar key) is not a shape we understand, and callers treat it as raw text.
const isKnownShape = (v, known) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).every((k) => k === 'changed_at' || known.includes(k));

const isEmptyRaw = (raw) => raw === null || raw === undefined || String(raw).trim() === '';

// One canonical, typed form of a Monday column value: { empty: true } or { kind, ... }.
// Malformed or unexpected shapes become { kind: 'raw' }, which compares by the raw text, so a
// bad value surfaces as a mismatch instead of crashing or passing as empty.
function canon(type, raw) {
  if (isEmptyRaw(raw)) return { empty: true };
  const p = parse(raw);
  const asRaw = { kind: 'raw', raw: String(raw) };
  if (!p.ok) return asRaw;
  const v = p.v;
  if (v === null) return { empty: true };
  switch (type) {
    case 'text': {
      if (typeof v !== 'string') return asRaw;
      return v === '' ? { empty: true } : { kind: 'text', value: v };
    }
    case 'numbers': {
      const s = typeof v === 'number' ? String(v) : v;
      if (typeof s !== 'string') return asRaw;
      if (s.trim() === '') return { empty: true };
      const n = Number(s);
      return {
        kind: 'numbers',
        value: Number.isFinite(n) ? String(n) : s.trim(),
        written: s,
      };
    }
    case 'checkbox': {
      if (!isKnownShape(v, ['checked'])) return asRaw;
      const c = v.checked;
      if (c === true || c === 'true') return { kind: 'checkbox' };
      if (c === false || c === 'false' || c === undefined || c === null) return { empty: true };
      return asRaw;
    }
    case 'date': {
      if (!isKnownShape(v, ['date', 'time'])) return asRaw;
      if (v.date === undefined || v.date === null || v.date === '') {
        return v.time ? asRaw : { empty: true };
      }
      if (typeof v.date !== 'string') return asRaw;
      const time = typeof v.time === 'string' && v.time !== '' ? v.time : undefined;
      return { kind: 'date', date: v.date, time };
    }
    case 'long_text': {
      if (typeof v !== 'string' && !isKnownShape(v, ['text'])) return asRaw;
      const text = typeof v === 'string' ? v : v.text;
      if (text === undefined || text === null) return { empty: true };
      if (typeof text !== 'string') return asRaw;
      return text === '' ? { empty: true } : { kind: 'long_text', text };
    }
    case 'link': {
      if (!isKnownShape(v, ['url', 'text'])) return asRaw;
      const url = v.url ?? '';
      const text = v.text ?? '';
      if (typeof url !== 'string' || typeof text !== 'string') return asRaw;
      return url === '' && text === '' ? { empty: true } : { kind: 'link', url, text };
    }
    default: {
      if (typeof v === 'object' && !Array.isArray(v)) {
        const rest = withoutChangedAt(v);
        return Object.keys(rest).length === 0
          ? { empty: true }
          : { kind: 'other', raw: JSON.stringify(stable(rest)) };
      }
      return { kind: 'other', raw: String(raw) };
    }
  }
}

function canonString(c) {
  if (c.empty) return '';
  switch (c.kind) {
    case 'text':
      return `text:${c.value}`;
    case 'numbers':
      return `numbers:${c.value}`;
    case 'checkbox':
      return 'checkbox:checked';
    case 'date':
      return `date:${c.date}${c.time ? ` ${c.time}` : ''}`;
    case 'long_text':
      return `long_text:${c.text}`;
    case 'link':
      return `link:${JSON.stringify([c.url, c.text])}`;
    case 'other':
      return `other:${c.raw}`;
    default:
      return `raw:${c.raw}`;
  }
}

/** A canonical string for a Monday column `value`, `''` for any empty form. Never throws. */
export function normalize(type, rawValue) {
  return canonString(canon(type, rawValue));
}

/**
 * The value to hand `change_multiple_column_values` / `create_item` for a column, with
 * `changed_at` dropped and `null` for empty. Throws (without quoting the value) on a value it
 * cannot read, so a bad cell stops the copy rather than writing garbage.
 */
export function toWrite(type, rawValue) {
  const c = canon(type, rawValue);
  if (c.empty) return null;
  switch (c.kind) {
    case 'text':
      return c.value;
    case 'numbers':
      return c.written;
    case 'checkbox':
      return { checked: 'true' };
    case 'date':
      return c.time ? { date: c.date, time: c.time } : { date: c.date };
    case 'long_text':
      return { text: c.text };
    case 'link':
      return { url: c.url, text: c.text };
    case 'other':
      return JSON.parse(c.raw);
    default:
      throw new Error(`unreadable ${type} column value`);
  }
}

// The cell for a title, found through bareTitle so a 🔒/📜 marker never hides it.
function cellFor(values, title) {
  for (const key of Object.keys(values ?? {})) {
    if (bareTitle(key) === title) return values[key];
  }
  return undefined;
}

// A People-side cell as it is copied: the profile loses its removed flags, nothing else changes.
function copiedRaw(title, cell) {
  if (!cell) return null;
  if (title !== PROFILE_TITLE || isEmptyRaw(cell.value)) return cell.value ?? null;
  const p = parse(cell.value);
  if (!p.ok) return cell.value;
  if (typeof p.v === 'string') return JSON.stringify(scrubProfile(p.v));
  if (p.v && typeof p.v === 'object' && typeof p.v.text === 'string') {
    return JSON.stringify({ ...withoutChangedAt(p.v), text: scrubProfile(p.v.text) });
  }
  return cell.value;
}

const copiedType = (cell) => cell?.type ?? 'text';

/** The `toWrite` value for a People-side cell, the profile scrubbed. */
export function valueToWrite(title, cell) {
  return toWrite(copiedType(cell), copiedRaw(title, cell));
}

function peopleNorm(title, values) {
  const cell = cellFor(values, title);
  return normalize(copiedType(cell), copiedRaw(title, cell));
}

function boardNorm(title, values) {
  const cell = cellFor(values, title);
  return normalize(copiedType(cell), cell?.value ?? null);
}

const hasAnyValue = (person) => WINDFALL_TITLES.some((t) => peopleNorm(t, person.values) !== '');

const stringsIn = (v) => {
  if (typeof v === 'string') return [v];
  if (v && typeof v === 'object') return Object.values(v).flatMap(stringsIn);
  return [];
};

/** True if a column value names a removed flag anywhere: as raw text, or in any string it parses to. */
export function mentionsRemovedFlag(raw) {
  if (isEmptyRaw(raw)) return false;
  const text = String(raw);
  if (REMOVED_FLAG_TEXT.test(text)) return true;
  const p = parse(text);
  return p.ok && stringsIn(p.v).some((s) => REMOVED_FLAG_TEXT.test(s));
}

/** People item ids whose profile still names a removed flag after the scrub: what copy would write. */
export function peopleStillFlagged(people) {
  const ids = new Set();
  for (const p of people) {
    const cell = cellFor(p.values, PROFILE_TITLE);
    if (mentionsRemovedFlag(copiedRaw(PROFILE_TITLE, cell))) ids.add(p.itemId);
  }
  return [...ids];
}

/** Board item ids whose profile names a removed flag, as it stands on the board. */
export function boardRowsFlagged(rows) {
  return rows
    .filter((row) => mentionsRemovedFlag(cellFor(row.values, PROFILE_TITLE)?.value))
    .map((row) => String(row.itemId));
}

/** People still to copy: those with a Windfall value (after the profile scrub) and no item yet. */
export function planItems(people, existingPersonIds) {
  const seen = new Set();
  const out = [];
  for (const p of people) {
    if (seen.has(p.itemId)) continue;
    seen.add(p.itemId);
    if (existingPersonIds.has(p.itemId)) continue;
    if (hasAnyValue(p)) out.push(p);
  }
  return out;
}

/**
 * Compare People rows to the private board's rows. Counts, plus `details` saying where each
 * problem is, in Monday ids and column titles only:
 *  - missing: people with a Windfall value and no board item (People item ids)
 *  - duplicates: people linked from more than one board item, each personId link counting (People
 *    item id and board item ids)
 *  - extra: board items linked to nobody on People, or to any id not in `people` (board item ids)
 *  - mismatches: people with a board item whose value differs in any of the 11 columns (People item
 *    id, the board items that differ, and the titles that differ)
 * The People profile is scrubbed before the comparison; the board's is not, so a flag still on
 * the board fails. A person with no value is not expected on the board; if they have an item,
 * it is compared like any other.
 */
export function reconcile(people, boardItems) {
  const byId = new Map();
  for (const p of people) if (!byId.has(p.itemId)) byId.set(p.itemId, p);

  const details = { missing: [], extra: [], duplicates: [], mismatches: [] };
  const links = new Map(); // person itemId -> board rows linking it, once per link
  for (const row of boardItems) {
    const ids = row.personIds ?? [];
    if (ids.length === 0 || ids.some((id) => !byId.has(String(id)))) details.extra.push(String(row.itemId));
    for (const id of ids) {
      const key = String(id);
      if (!byId.has(key)) continue;
      if (!links.has(key)) links.set(key, []);
      links.get(key).push(row);
    }
  }

  for (const p of byId.values()) {
    const rows = links.get(p.itemId) ?? [];
    if (rows.length === 0) {
      if (hasAnyValue(p)) details.missing.push(p.itemId);
      continue;
    }
    if (rows.length > 1) details.duplicates.push({ personId: p.itemId, boardItemIds: rows.map((r) => String(r.itemId)) });
    const differing = rows
      .map((row) => ({
        row,
        titles: WINDFALL_TITLES.filter((t) => peopleNorm(t, p.values) !== boardNorm(t, row.values)),
      }))
      .filter((d) => d.titles.length > 0);
    if (differing.length > 0) {
      details.mismatches.push({
        personId: p.itemId,
        boardItemIds: differing.map((d) => String(d.row.itemId)),
        titles: WINDFALL_TITLES.filter((t) => differing.some((d) => d.titles.includes(t))),
      });
    }
  }

  const perColumn = {};
  for (const t of WINDFALL_TITLES) {
    perColumn[t] = {
      people: people.filter((p) => peopleNorm(t, p.values) !== '').length,
      board: boardItems.filter((r) => boardNorm(t, r.values) !== '').length,
    };
  }

  return {
    people: people.length,
    items: boardItems.length,
    missing: details.missing.length,
    extra: details.extra.length,
    duplicates: details.duplicates.length,
    mismatches: details.mismatches.length,
    perColumn,
    details,
  };
}

/** True only when nothing is missing, extra, duplicated or different, and the column counts agree. */
export function isClean(result) {
  return (
    result.missing === 0 &&
    result.extra === 0 &&
    result.duplicates === 0 &&
    result.mismatches === 0 &&
    Object.values(result.perColumn).every((c) => c.people === c.board)
  );
}

const itemList = (ids) => `board item${ids.length === 1 ? '' : 's'} ${ids.join(', ')}`;

/** Counts, Monday item ids and column titles. No value and no name. */
export function formatReport(result) {
  const lines = [
    `People rows: ${result.people}`,
    `Board items: ${result.items}`,
    `Missing: ${result.missing}`,
    `Extra: ${result.extra}`,
    `Duplicates: ${result.duplicates}`,
    `Mismatches: ${result.mismatches}`,
    'Non-empty values per column (People / Board):',
  ];
  for (const t of WINDFALL_TITLES) {
    const c = result.perColumn[t];
    lines.push(`  ${t}: ${c.people} / ${c.board}`);
  }
  const { details } = result;
  for (const id of details.missing) lines.push(`Missing: People item ${id}`);
  for (const id of details.extra) lines.push(`Extra: board item ${id}`);
  for (const d of details.duplicates) lines.push(`Duplicate: People item ${d.personId} on ${itemList(d.boardItemIds)}`);
  for (const m of details.mismatches) lines.push(`Mismatch: People item ${m.personId}, ${itemList(m.boardItemIds)}: ${m.titles.join(', ')}`);
  lines.push(isClean(result) ? 'Result: clean' : 'Result: NOT clean');
  return lines.join('\n');
}

/** A snapshot line this tool can't read. The message is ours: a line number, never the line. */
export class SnapshotError extends Error {}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function snapshotHeader(record, lineNo) {
  const bad = (what) => new SnapshotError(`Line ${lineNo}: ${what}.`);
  const boardId = record.board?.id;
  if (!/^\d+$/.test(String(boardId ?? ''))) throw bad('the board header has no numeric board id');
  const columns = record.schema?.columns;
  if (!Array.isArray(columns) || columns.some((c) => !isPlainObject(c) || typeof c.title !== 'string' || typeof c.id !== 'string')) {
    throw bad('the board header has no readable column list');
  }
  const byTitle = new Map();
  const missingTitles = [];
  for (const title of WINDFALL_TITLES) {
    const matches = columns.filter((c) => bareTitle(c.title) === title);
    if (matches.length > 1) throw bad(`"${title}" is on ${matches.length} columns`);
    if (matches.length === 0) missingTitles.push(title);
    else byTitle.set(title, matches[0]);
  }
  return { boardId: String(boardId), byTitle, missingTitles };
}

function countSnapshotItem(record, lineNo, header, perColumn) {
  const bad = (what) => new SnapshotError(`Line ${lineNo}: ${what}.`);
  const cells = record.item?.columnValues;
  if (!Array.isArray(cells) || cells.some((c) => !isPlainObject(c))) throw bad('the item has no readable column values');
  const byId = new Map(cells.map((c) => [c.id, c]));
  for (const [title, column] of header.byTitle) {
    const cell = byId.get(column.id);
    if (!cell) throw bad(`the item leaves out "${title}"`);
    if (cell.value !== null && typeof cell.value !== 'string') throw bad(`the item's "${title}" isn't a column value`);
    const type = typeof cell.type === 'string' ? cell.type : column.type;
    if (normalize(type, cell.value) !== '') perColumn[title] += 1;
  }
}

/**
 * Per-title non-empty counts for one monday-backup board file (`board-<id>.jsonl`, one JSON record
 * per line: a `board` header, then `item` and `update` records; monday-backup/src/format.ts). Takes
 * the lines as any iterable and keeps no value. The counts are unscrubbed, unlike reconcile's
 * perColumn. Throws SnapshotError on a line it can't read; a title the board lacks is returned in
 * `missingTitles`, with no count.
 */
export async function countSnapshot(lines) {
  let lineNo = 0;
  let header = null;
  let items = 0;
  const perColumn = {};
  for await (const text of lines) {
    lineNo += 1;
    const p = parse(text);
    if (!p.ok || !isPlainObject(p.v)) throw new SnapshotError(`Line ${lineNo}: not a JSON record.`);
    const record = p.v;
    if (record.type === 'board') {
      if (header) throw new SnapshotError(`Line ${lineNo}: a second board header; pipe one board file at a time.`);
      header = snapshotHeader(record, lineNo);
      for (const title of header.byTitle.keys()) perColumn[title] = 0;
    } else if (record.type === 'item' || record.type === 'update') {
      if (!header) throw new SnapshotError(`Line ${lineNo}: a record before the board header.`);
      if (record.type === 'item') {
        countSnapshotItem(record, lineNo, header, perColumn);
        items += 1;
      } else if (!isPlainObject(record.update)) {
        throw new SnapshotError(`Line ${lineNo}: the update has no body.`);
      }
    } else {
      throw new SnapshotError(`Line ${lineNo}: not a board file record.`);
    }
  }
  if (!header) throw new SnapshotError('No board header: the input was empty, or not a board file.');
  return { boardId: header.boardId, items, perColumn, missingTitles: header.missingTitles };
}

/** Counts, the board id and column titles. */
export function formatSnapshotCounts(result) {
  const lines = [`Board ${result.boardId}: ${result.items} item(s).`, 'Non-empty values per column:'];
  for (const t of WINDFALL_TITLES) {
    if (t in result.perColumn) lines.push(`  ${t}: ${result.perColumn[t]}`);
  }
  return lines.join('\n');
}
