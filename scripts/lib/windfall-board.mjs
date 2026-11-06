// Logic for moving purchased wealth-screening (Windfall) data off the two Monday People boards
// onto a private board, and for proving the copy is complete before the source columns are deleted.
//
// Pure and dependency-free: the operator script does the Monday calls. A false "clean" from
// reconcile() loses data, so every doubtful case here fails toward "mismatch". Windfall values
// never leave this module except as write payloads: results and reports hold counts and Monday
// ids only, and errors never quote a value.

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
 * Compare People rows to the private board's rows, by counts only.
 *  - missing: people with a Windfall value and no board item
 *  - duplicates: people linked from more than one board item (each personId link counts)
 *  - extra: board items linked to nobody on People, or to any id not in `people`
 *  - mismatches: people with a board item whose value differs in any of the 11 columns
 * The People profile is scrubbed before the comparison; the board's is not, so a flag still on
 * the board fails. A person with no value is not expected on the board; if they have an item,
 * it is compared like any other.
 */
export function reconcile(people, boardItems) {
  const byId = new Map();
  for (const p of people) if (!byId.has(p.itemId)) byId.set(p.itemId, p);

  const links = new Map(); // person itemId -> board rows linking it, once per link
  let extra = 0;
  for (const row of boardItems) {
    const ids = row.personIds ?? [];
    if (ids.length === 0 || ids.some((id) => !byId.has(String(id)))) extra += 1;
    for (const id of ids) {
      const key = String(id);
      if (!byId.has(key)) continue;
      if (!links.has(key)) links.set(key, []);
      links.get(key).push(row);
    }
  }

  let missing = 0;
  let duplicates = 0;
  let mismatches = 0;
  for (const p of byId.values()) {
    const rows = links.get(p.itemId) ?? [];
    if (rows.length === 0) {
      if (hasAnyValue(p)) missing += 1;
      continue;
    }
    if (rows.length > 1) duplicates += 1;
    const differs = rows.some((row) =>
      WINDFALL_TITLES.some((t) => peopleNorm(t, p.values) !== boardNorm(t, row.values)),
    );
    if (differs) mismatches += 1;
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
    missing,
    extra,
    duplicates,
    mismatches,
    perColumn,
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

/** Counts only: no value, name or id is printed. */
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
  lines.push(isClean(result) ? 'Result: clean' : 'Result: NOT clean');
  return lines.join('\n');
}
