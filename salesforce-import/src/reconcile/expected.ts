import { fiscalYear } from '../transform/fields.js';
import { cnpOverlapCheck } from '../transform/donations.js';
import type { ItemPayload } from '../transform/types.js';

type Row = Record<string, unknown>;

/** One gift as the reconciliation sees it: which fiscal year it falls in and what it's worth. */
export interface Gift { sfId: string; fy: string; cents: number }
export interface Totals { count: number; cents: number }

export const UNDATED = '(undated)';

export const toCents = (amount: unknown): number => {
  const n = Number(amount ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

export const fyOf = (dateISO: unknown): string =>
  (typeof dateISO === 'string' && fiscalYear(dateISO)) || UNDATED;

/**
 * Every gift the frozen extract says must be on the Donations board: all Opportunities (every
 * stage — each one migrates, Closed Lost included) plus the Click & Pledge transactions that
 * aren't already an Opportunity. Computed from the extract alone, not from transform output.
 */
export function expectedGifts(opportunities: readonly Row[], cnp: readonly Row[]):
  { gifts: Gift[]; cnpUnique: number; cnpOverlap: number } {
  const { unique, duplicateTransactionIds } = cnpOverlapCheck([...cnp], [...opportunities]);
  const gifts = [
    ...opportunities.map((o) => ({ sfId: o['Id'] as string, fy: fyOf(o['CloseDate']), cents: toCents(o['Amount']) })),
    ...unique.map((t) => ({ sfId: t['Id'] as string, fy: fyOf(t['CnP_PaaS__TransactionDate__c']),
      cents: toCents(t['CnP_PaaS__TotalCharged__c']) })),
  ];
  return { gifts, cnpUnique: unique.length, cnpOverlap: duplicateTransactionIds.length };
}

export function totalsByFY(gifts: Iterable<Pick<Gift, 'fy' | 'cents'>>): Map<string, Totals> {
  const out = new Map<string, Totals>();
  for (const g of gifts) {
    const t = out.get(g.fy) ?? out.set(g.fy, { count: 0, cents: 0 }).get(g.fy)!;
    t.count++;
    t.cents += g.cents;
  }
  return out;
}

/** Undated first, then fiscal years ascending. */
export const fyOrder = (a: string, b: string): number =>
  a === UNDATED ? -1 : b === UNDATED ? 1 : a.localeCompare(b);

export interface TopDonor { sfId: string; board: string; name: string; lifetimeCents: number; giftCount: number }

/**
 * The N largest donors by the Lifetime Giving the importer computed from the frozen extract
 * (Posted Opportunities and Eventbrite ticket orders + unique Click & Pledge, credited the way
 * the Donor link is — see transform/rollups.ts). donation-rollups recomputes the same column from the gifts actually on
 * Monday, so a dropped, duplicated or re-pointed gift shows up as a difference here.
 */
export function topDonors(payloads: readonly ItemPayload[], n: number): TopDonor[] {
  return payloads
    .filter((p) => p.board !== 'donations' && p.columns['Lifetime Giving'] !== undefined)
    .map((p) => ({ sfId: p.sfId, board: p.board, name: p.name,
      lifetimeCents: toCents(p.columns['Lifetime Giving']), giftCount: Number(p.columns['Gift Count'] ?? 0) }))
    .filter((d) => d.lifetimeCents > 0)
    .sort((a, b) => b.lifetimeCents - a.lifetimeCents || a.sfId.localeCompare(b.sfId))
    .slice(0, n);
}
