// "Sponsorships" section of an Organizations item's description: paid and in-kind sponsorship
// gifts over a rolling window of years, newest first. Pure renderer; the recompute path decides
// when to write it. Like Gift History it is rebuildable from the ledger and carries no authority.

import type { FiscalYearConfig, SponsorshipsConfig } from '../types';
import { fiscalYearFromDate } from '../rollups/compute';
import { cell, dollars, type GiftHistoryRow } from './giftHistory';

interface Entry {
  row: GiftHistoryRow;
  year: string;
  inKind: boolean;
  cents: number;
}

// null = no qualifying gift in the window.
export function buildSponsorshipsMarkdown(
  rows: GiftHistoryRow[], cfg: SponsorshipsConfig, receivedStatusLabel: string,
  fiscalYear: FiscalYearConfig, accountUrl: string, todayISO: string,
): string | null {
  const fiscal = cfg.yearBasis === 'fiscal';
  const yearNum = (dateISO: string): number =>
    fiscal ? fiscalYearFromDate(dateISO, fiscalYear.startMonth) : Number(dateISO.slice(0, 4));
  const label = (n: number): string => (fiscal ? `FY${String(n % 100).padStart(2, '0')}` : String(n));

  const last = yearNum(todayISO);
  const first = last - (cfg.windowYears - 1);

  const entries: Entry[] = [];
  for (const r of rows) {
    if (!r.giftDateISO || r.status !== receivedStatusLabel) continue;
    const inKind = r.giftType !== null && cfg.inKindGiftTypes.includes(r.giftType);
    const cash = r.giftType !== null && cfg.giftTypes.includes(r.giftType);
    if (!inKind && !cash) continue;
    const y = yearNum(r.giftDateISO);
    if (!(y >= first && y <= last)) continue; // also drops an unparseable date (NaN)
    const cents = inKind
      ? (r.inKindValueCents !== null && r.inKindValueCents > 0 ? r.inKindValueCents : r.amountCents)
      : r.amountCents;
    entries.push({ row: r, year: label(y), inKind, cents });
  }
  if (entries.length === 0) return null;

  const totalOf = (es: Entry[]): string => {
    const cashCents = es.filter((e) => !e.inKind).reduce((s, e) => s + e.cents, 0);
    const kindCents = es.filter((e) => e.inKind).reduce((s, e) => s + e.cents, 0);
    const parts: string[] = [];
    if (cashCents > 0 || kindCents === 0) parts.push(kindCents > 0 ? `${dollars(cashCents)} cash` : dollars(cashCents));
    if (kindCents > 0) parts.push(`${dollars(kindCents)} in-kind`);
    return `**${parts.join(' · ')}**`;
  };

  const lines = ['## Sponsorships', '', '| Year | Date | Event | Amount |', '| --- | --- | --- | --- |'];
  for (let y = last; y >= first; y--) {
    const yl = label(y);
    const inYear = entries
      .filter((e) => e.year === yl)
      .sort((a, b) =>
        b.row.giftDateISO.localeCompare(a.row.giftDateISO) || a.row.mondayItemId.localeCompare(b.row.mondayItemId));
    if (inYear.length === 0) continue;
    for (const e of inYear) {
      const r = e.row;
      const dateCell = r.donationBoardId
        ? `[${r.giftDateISO}](${accountUrl}/boards/${r.donationBoardId}/pulses/${r.mondayItemId})`
        : r.giftDateISO;
      const event = (r.sponsorshipEvent ?? '').trim();
      lines.push(`| ${yl} | ${dateCell} | ${event ? cell(event) : '—'} | ${dollars(e.cents)}${e.inKind ? ' (in-kind)' : ''} |`);
    }
    lines.push(`| **${yl} total** | | | ${totalOf(inYear)} |`);
  }
  lines.push(`| **Total, ${label(first)}–${label(last)}** | | | ${totalOf(entries)} |`);
  lines.push('', `_Paid and in-kind sponsorships, last ${cfg.windowYears} ${fiscal ? 'fiscal' : 'calendar'} years. Maintained automatically by donation-rollups — edits here are overwritten._`);
  return lines.join('\n');
}
