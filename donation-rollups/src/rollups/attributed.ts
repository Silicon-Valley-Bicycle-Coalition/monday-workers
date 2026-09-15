import type { AffiliationsConfig } from '../types';

// Per-affiliation money rollups (spec "Rollups"): what a person drove for one organization
// during one tenure. Lifetime, not fiscal-year split — there is no This/Last Year here.
export interface AttributedRollup { attributedGiving: number; attributedGiftCount: number; lastAttributedGiftISO: string | null }

export function attributedRollupFromTotals(t: { cents: number; count: number; lastGiftDateISO: string | null }): AttributedRollup {
  return { attributedGiving: t.cents / 100, attributedGiftCount: t.count, lastAttributedGiftISO: t.lastGiftDateISO };
}

// Explicit zeros, not blanks: a tenure whose last attributed gift was re-pointed elsewhere
// must read 0, or the stale total would sit there looking current.
export function attributedToColumnValues(r: AttributedRollup, columns: AffiliationsConfig['columns']): Record<string, unknown> {
  return {
    [columns.attributedGiving]: String(r.attributedGiving),
    [columns.attributedGiftCount]: String(r.attributedGiftCount),
    [columns.lastAttributedGift]: r.lastAttributedGiftISO === null ? null : { date: r.lastAttributedGiftISO.slice(0, 10) },
  };
}

export function organizationalGivingColumnValue(cents: number): string {
  return String(cents / 100);
}
