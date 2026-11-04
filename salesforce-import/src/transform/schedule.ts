import type { ItemPayload } from './types.js';
import { fiscalYear } from './fields.js';

// Archive-in-place schedule for the single Donations board (docs/20 in the private planning
// repo). Archived items don't count toward Monday's 10k-per-board active-item ceiling, so one
// board holds all gift history: load walks fiscal years oldest-first and archives each year
// beyond the retention window right after its items and links land, keeping the active count
// bounded while total history is unbounded. Fiscal year (July–June) is already computed on
// every donation payload; '' (undated) rows sort oldest and are always archived.

export interface ArchivePlan {
  cutoffFY: number; // first fiscal year that stays active
  countsByFY: Map<string, number>;
  peakActive: number; // max items active on the board at any point during the load
}

const payloadFY = (p: ItemPayload): string => String(p.columns['Fiscal Year Ending'] ?? '');

// First fiscal year that stays active: the cutover's, and activeFiscalYears - 1 before it.
export function archiveCutoffFY(cutoverDateISO: string, activeFiscalYears: number): number {
  // fiscalYear() returns '' on a malformed date, which Number() coerces to 0 — not NaN.
  const currentFY = Number(fiscalYear(cutoverDateISO));
  if (!Number.isInteger(currentFY) || currentFY <= 0) {
    throw new Error(`schedule: bad cutoverDateISO "${cutoverDateISO}"`);
  }
  return currentFY - activeFiscalYears + 1;
}

export function donationArchivePlan(
  donations: ItemPayload[], cutoverDateISO: string, activeFiscalYears: number,
): ArchivePlan {
  const cutoffFY = archiveCutoffFY(cutoverDateISO, activeFiscalYears);
  const countsByFY = new Map<string, number>();
  for (const p of donations) {
    const fy = payloadFY(p);
    countsByFY.set(fy, (countsByFY.get(fy) ?? 0) + 1);
  }
  // Archived fiscal years each drain off the board before the next begins, so only one is
  // active at a time; retained years accumulate and stay. Future-dated gifts count as retained.
  let retained = 0, maxArchivedBatch = 0;
  for (const [fy, n] of countsByFY) {
    if (isArchivedFY(fy, cutoffFY)) maxArchivedBatch = Math.max(maxArchivedBatch, n);
    else retained += n;
  }
  return { cutoffFY, countsByFY, peakActive: Math.max(maxArchivedBatch, retained) };
}

function isArchivedFY(fy: string, cutoffFY: number): boolean {
  if (fy === '') return true; // undated → treated as oldest history
  return Number(fy) < cutoffFY;
}

export function shouldArchive(p: ItemPayload, plan: ArchivePlan): boolean {
  return isArchivedFY(payloadFY(p), plan.cutoffFY);
}

// Load-order key: undated first, then fiscal years ascending — archived years all precede
// retained ones because retained years are by definition the newest.
export function fiscalYearLoadOrder(fys: Iterable<string>): string[] {
  return [...fys].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : Number(a) - Number(b)));
}
