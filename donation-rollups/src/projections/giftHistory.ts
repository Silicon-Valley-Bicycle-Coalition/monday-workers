// Donor gift-history projections (docs/20 §5.5 in the private planning repo): each owner item
// carries its lifetime history as DATA, because Monday's relations are the one thing archiving
// breaks — archived gifts' board_relation values read empty, and items_page never lists them.
// Two renderings, both written by the recompute path from the D1 gifts ledger:
//  1. a machine-readable "Gift Ledger (JSON)" text column — the scale-free interface —
//  2. a human-readable markdown gift-history table in the owner item's description, with a
//     deep link per gift (an archived item's link renders the full item card with an
//     "archived" banner — verified in the UI 2026-08-25).
// Corrupt or stale projections are rebuildable from the ledger; they carry no authority.

export interface GiftHistoryRow {
  mondayItemId: string;
  donationBoardId: string | null; // null when donation_links has no row (shouldn't happen)
  amountCents: number;
  giftDateISO: string; // '' when unknown
  fiscalYear: number;
  status: string;
  giftType: string | null;
  actingForItemId: string | null;
  archived: boolean;
}

// Docs/20: overflow must be a planned decision, never a surprise truncation — the recompute
// path alerts (custodian path, not just a log line) once a projection passes this threshold,
// well before the item budget, so reconciliation-era humans see it coming.
export const GIFT_LEDGER_ALERT_BYTES = 48_000;
// Hard write budget, safely under Monday's ~64KB per-item ceiling: past this the projection
// is truncated to the newest entries that fit (plus a marker) instead of letting the one
// combined column write throw, DLQ the donor, and freeze their rollups forever.
export const GIFT_LEDGER_MAX_BYTES = 60_000;
// First tuple element of the marker entry a truncated projection ends with. '~' can never
// collide with a Monday item id (they're numeric), and reconciliation keys off it.
export const GIFT_LEDGER_TRUNCATION_ID = '~truncated';

export interface GiftLedgerProjection {
  json: string; // what to write to the column — truncated when the full form won't fit
  fullBytes: number; // byte size of the untruncated projection (the alert-decision number)
  truncated: boolean;
  totalCount: number;
  includedCount: number;
}

type GiftLedgerTuple = [string, string, number, string, string, string];

const tuple = (r: GiftHistoryRow): GiftLedgerTuple =>
  [r.mondayItemId, r.giftDateISO, r.amountCents, r.giftType ?? '', r.status, r.actingForItemId ?? ''];

// Newest first. Compact tuple form: [itemId, dateISO, cents, type, status, actingForItemId] ≈
// 50 bytes/gift — a 20-year monthly donor (~240 gifts) is ~12KB against Monday's ~64KB
// per-item budget.
export function buildGiftLedgerJson(rows: GiftHistoryRow[]): GiftLedgerProjection {
  const tuples = sorted(rows).map(tuple);
  const encoder = new TextEncoder();
  const full = JSON.stringify(tuples);
  const fullBytes = encoder.encode(full).length;
  if (fullBytes <= GIFT_LEDGER_MAX_BYTES) {
    return { json: full, fullBytes, truncated: false, totalCount: rows.length, includedCount: rows.length };
  }

  // Keep the newest entries that fit alongside a marker tuple in the oldest position. The
  // marker carries 0 cents so a naive sum over the tuples stays honest, and its "N of M"
  // note points at D1, which still holds the full history.
  const marker = (included: number): GiftLedgerTuple => [
    GIFT_LEDGER_TRUNCATION_ID, '', 0, '',
    `${rows.length - included} older of ${rows.length} gifts omitted — full history in the D1 gifts ledger`,
    '',
  ];
  // Budgeting against the worst-case marker (included = 0 has the most omitted digits).
  let bytes = encoder.encode(JSON.stringify([marker(0)])).length;
  const kept: GiftLedgerTuple[] = [];
  for (const t of tuples) {
    bytes += encoder.encode(JSON.stringify(t)).length + 1; // +1 for the joining comma
    if (bytes > GIFT_LEDGER_MAX_BYTES) break;
    kept.push(t);
  }
  return {
    json: JSON.stringify([...kept, marker(kept.length)]),
    fullBytes, truncated: true, totalCount: rows.length, includedCount: kept.length,
  };
}

export interface ParsedGiftLedger {
  entries: { mondayItemId: string; amountCents: number; status: string }[];
  truncated: boolean;
}

// Reconciliation's reader for the column above: null means "not a projection we wrote"
// (unparseable, wrong shape) — the caller decides whether that's drift. The truncation
// marker is stripped from entries and reported as a flag.
export function parseGiftLedgerJson(text: string): ParsedGiftLedger | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const entries: ParsedGiftLedger['entries'] = [];
  let truncated = false;
  for (const t of raw) {
    if (!Array.isArray(t) || t.length < 5) return null;
    if (t[0] === GIFT_LEDGER_TRUNCATION_ID) {
      truncated = true;
      continue;
    }
    if (typeof t[0] !== 'string' || typeof t[2] !== 'number' || typeof t[4] !== 'string') return null;
    entries.push({ mondayItemId: t[0], amountCents: t[2], status: t[4] });
  }
  return { entries, truncated };
}

const dollars = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const cell = (text: string): string => text.replace(/\|/g, '\\|');

export function buildGiftHistoryMarkdown(
  rows: GiftHistoryRow[], accountUrl: string,
  driven?: { affiliationName: string; cents: number; count: number }[],
): string {
  const lines = [
    '## Gift History',
    '',
    '| Date | Amount | Type | Status |',
    '| --- | --- | --- | --- |',
  ];
  for (const r of sorted(rows)) {
    const date = r.giftDateISO || '(undated)';
    const cell = r.donationBoardId
      ? `[${date}](${accountUrl}/boards/${r.donationBoardId}/pulses/${r.mondayItemId})`
      : date;
    lines.push(`| ${cell} | ${dollars(r.amountCents)} | ${r.giftType ?? ''} | ${r.status} |`);
  }
  lines.push('', `_${rows.length} gifts. Maintained automatically by donation-rollups — edits here are overwritten._`);
  if (driven && driven.length > 0) {
    lines.push('', '## Driven for organizations', '', '| Affiliation | Attributed giving | Gifts |', '| --- | --- | --- |');
    for (const d of driven) lines.push(`| ${cell(d.affiliationName)} | ${dollars(d.cents)} | ${d.count} |`);
  }
  return lines.join('\n');
}

function sorted(rows: GiftHistoryRow[]): GiftHistoryRow[] {
  return [...rows].sort((a, b) =>
    b.giftDateISO.localeCompare(a.giftDateISO) || a.mondayItemId.localeCompare(b.mondayItemId));
}
