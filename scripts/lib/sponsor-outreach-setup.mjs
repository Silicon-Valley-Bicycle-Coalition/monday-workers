// Matching and formatting logic for the Sponsor Outreach one-time setup
// (scripts/sponsor-outreach-setup.mjs). Design:
// docs/superpowers/specs/2026-11-09-sponsor-outreach-board-design.md
//
// Pure and dependency-free: the operator script does the Monday calls. Matching is exact after
// normalization only. Anything that doesn't match exactly once is reported, never guessed.

import { resolve, sep } from 'node:path';

const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'corp', 'corporation', 'co', 'company', 'lp', 'llp', 'pbc',
]);

/** Normalize a company name for exact matching ("Google, Inc." and "Google LLC" → "google"). */
export function orgKey(name) {
  const words = String(name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length > 1 && words[0] === 'the') words.shift();
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** Map each normalized name to the Organization ids that carry it. */
export function buildOrgIndex(orgs) {
  const index = new Map();
  for (const { id, name } of orgs) {
    const key = orgKey(name);
    if (!key) continue;
    const ids = index.get(key) ?? [];
    if (!ids.includes(id)) ids.push(id);
    index.set(key, ids);
  }
  return index;
}

/**
 * Try each name in order; the first that matches exactly one Organization wins. With no single
 * match, a name that matched several makes the result ambiguous (first such name's candidates).
 */
export function matchOrg(index, ...names) {
  let ambiguous = null;
  for (const name of names) {
    if (!name) continue;
    const ids = index.get(orgKey(name));
    if (!ids) continue;
    if (ids.length === 1) return { status: 'matched', orgId: ids[0] };
    ambiguous ??= ids;
  }
  return ambiguous ? { status: 'ambiguous', candidates: [...ambiguous] } : { status: 'unmatched' };
}

/** Every address in a free-text cell, lowercased, de-duplicated, in order. */
export function splitEmails(cell) {
  const out = [];
  for (const part of String(cell ?? '').split(/[;,\s]+/)) {
    const email = part.trim().toLowerCase();
    if (email.includes('@') && !out.includes(email)) out.push(email);
  }
  return out;
}

/**
 * The gifts of the given types from an owner's 🔒 Gift Ledger (JSON): donation-rollups writes it
 * from its D1 ledger, so it includes archived gifts, which items_page can't see. Tuples are
 * [itemId, dateISO, cents, type, status, actingForItemId].
 */
export function ledgerGifts(json, types) {
  let rows;
  try {
    rows = JSON.parse(json ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const want = new Set(types);
  return rows
    .filter((r) => Array.isArray(r) && want.has(r[3]))
    .map(([itemId, date, cents, type, status]) => ({ itemId: String(itemId), date, cents, type, status }));
}

/** "2022 Regional BTWD" → { year: 2022, event: "Regional BTWD" }; null without a leading year. */
export function parseCycle(text) {
  const m = /^\s*(\d{4})\s+(.+?)\s*$/.exec(String(text ?? ''));
  return m ? { year: Number(m[1]), event: m[2] } : null;
}

/**
 * Every cycle in a Sponsorship Cycle cell. Salesforce's field was multi-select ("2024 BTWD; 2024
 * Advocacy Summit") and older values combine two events ("2016 Dinner / 2017 BTWD", "2013 BTWD /
 * Dinner"), so the cell splits on ";" and "/". A part without its own year takes the previous
 * part's; a part that's only a year is dropped.
 */
export function parseCycles(text) {
  const out = [];
  let year = null;
  for (const part of String(text ?? '').split(/[;/]/)) {
    const m = /^\s*(\d{4})?\s*(.*?)\s*$/.exec(part);
    if (m[1]) year = Number(m[1]);
    if (year !== null && m[2]) out.push({ year, event: m[2] });
  }
  return out;
}

const eventKey =(s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();

/** Look a cycle's event text up in the table, ignoring case and spacing. */
export function mapEvent(event, table) {
  const key = eventKey(event);
  for (const [from, to] of Object.entries(table)) if (eventKey(from) === key) return to;
  return null;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** RFC 4180 CSV, one line per row, ending with a newline. */
export function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

/** Review files hold names and emails, so they may only be written inside a data/ directory. */
export function assertDataPath(path) {
  const parts = resolve(path).split(sep);
  if (!parts.slice(0, -1).includes('data')) {
    throw new Error('--out must be inside a directory named data/ (gitignored); refusing to write elsewhere');
  }
}
