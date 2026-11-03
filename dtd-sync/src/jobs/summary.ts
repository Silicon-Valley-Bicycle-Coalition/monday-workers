import type { DtdSyncConfig } from '../config';
import type { DtdMondayClient } from '../monday/client';
import { recordsForFiscalYear } from '../db/records';
import { MATCHING_GIFT_TYPE } from '../pairing/pair';
import { computeSummary, fiscalYearBounds, fiscalYearOf } from '../reporting/summary';

export interface SummaryDeps { monday: DtdMondayClient; db: D1Database; config: DtdSyncConfig }

/** Rewrites the Program Summary rows for the current and previous fiscal year; every run recomputes from scratch. */
export async function runSummary(deps: SummaryDeps, now: Date): Promise<void> {
  const { monday, db, config } = deps;
  const c = config.programSummary;
  const today = now.toISOString().slice(0, 10);
  const matchingDonations = (await monday.listDonationsDatedSince('2000-01-01')).filter(
    (i) => i.giftType === MATCHING_GIFT_TYPE && i.date !== null,
  );

  const currentEnd = Number(fiscalYearOf(today).slice(2));
  for (const fy of [`FY${currentEnd}`, `FY${currentEnd - 1}`]) {
    const { startISO, endISO } = fiscalYearBounds(fy);
    const startDate = startISO.slice(0, 10);
    const endDate = endISO.slice(0, 10);
    const matches = matchingDonations.filter((m) => m.date! >= startDate && m.date! < endDate);
    const earlier = matchingDonations.filter((m) => m.date! < startDate);
    const priorCompanies = new Set(earlier.map((m) => m.matchedByItemId).filter((id): id is string => id !== null));
    const priorDonors = new Set(earlier.map((m) => m.donorItemId).filter((id): id is string => id !== null));

    const giftAmountById = new Map<string, number>();
    for (const giftId of new Set(matches.map((m) => m.matchesGiftItemId).filter((id): id is string => id !== null))) {
      const gift = await monday.getDonation(giftId);
      if (gift !== null && gift.amount !== null) giftAmountById.set(giftId, gift.amount);
    }

    const records = await recordsForFiscalYear(db, startISO, endISO);
    const s = computeSummary(records, matches, giftAmountById, priorCompanies, priorDonors);
    // Numbers columns take decimal strings (same as donation-rollups).
    await monday.upsertProgramSummary(fy, {
      [c.screened]: String(s.screened),
      [c.employerIdentified]: String(s.employerIdentified),
      [c.eligible]: String(s.eligible),
      [c.submitted]: String(s.submitted),
      [c.matchesPaid]: String(s.matchesPaid),
      [c.matchDollars]: s.matchDollars.toFixed(2),
      [c.matchedGiftDollars]: s.matchedGiftDollars.toFixed(2),
      [c.newMatchingCompanies]: String(s.newMatchingCompanies),
      [c.firstTimeMatchedDonors]: String(s.firstTimeMatchedDonors),
      [c.asOf]: { date: today },
    });
    console.log(JSON.stringify({ job: 'summary', fiscalYear: fy, screened: s.screened, matchesPaid: s.matchesPaid }));
  }
}
