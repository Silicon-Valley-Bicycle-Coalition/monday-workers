import type { AffiliationsConfig } from '../types';
import { formatCents } from '../money';

// Per-affiliation money rollups (spec "Rollups"): what a person drove for one organization
// during one tenure. Lifetime, not fiscal-year split — there is no This/Last Year here.
// Integer cents throughout (issue #27); formatted only at the column write.
export interface AttributedRollup { attributedGivingCents: number; attributedGiftCount: number; lastAttributedGiftISO: string | null }

export function attributedRollupFromTotals(t: { cents: number; count: number; lastGiftDateISO: string | null }): AttributedRollup {
  return { attributedGivingCents: t.cents, attributedGiftCount: t.count, lastAttributedGiftISO: t.lastGiftDateISO };
}

// Explicit zeros, not blanks: a tenure whose last attributed gift was re-pointed elsewhere
// must read 0, or the stale total would sit there looking current.
export function attributedToColumnValues(r: AttributedRollup, columns: AffiliationsConfig['columns']): Record<string, unknown> {
  return {
    [columns.attributedGiving]: formatCents(r.attributedGivingCents),
    [columns.attributedGiftCount]: String(r.attributedGiftCount),
    [columns.lastAttributedGift]: r.lastAttributedGiftISO === null ? null : { date: r.lastAttributedGiftISO.slice(0, 10) },
  };
}

export function organizationalGivingColumnValue(cents: number): string {
  return formatCents(cents);
}
