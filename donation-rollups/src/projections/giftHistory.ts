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
  archived: boolean;
}

// Newest first. Compact tuple form: [itemId, dateISO, cents, type, status] ≈ 45 bytes/gift —
// a 20-year monthly donor (~240 gifts) is ~11KB against Monday's ~64KB per-item budget.
export function buildGiftLedgerJson(rows: GiftHistoryRow[]): string {
  const json = JSON.stringify(sorted(rows).map((r) =>
    [r.mondayItemId, r.giftDateISO, r.amountCents, r.giftType ?? '', r.status]));
  // Docs/20: overflow must be a planned decision, never a surprise truncation — warn well
  // before the item budget so reconciliation-era humans see it coming.
  if (json.length > 48_000) {
    console.warn(`gift-history: JSON projection is ${json.length} bytes for an owner — approaching Monday's per-item budget`);
  }
  return json;
}

const dollars = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function buildGiftHistoryMarkdown(rows: GiftHistoryRow[], accountUrl: string): string {
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
  return lines.join('\n');
}

function sorted(rows: GiftHistoryRow[]): GiftHistoryRow[] {
  return [...rows].sort((a, b) =>
    b.giftDateISO.localeCompare(a.giftDateISO) || a.mondayItemId.localeCompare(b.mondayItemId));
}
