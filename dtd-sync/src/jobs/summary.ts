import type { DtdSyncConfig } from '../config';
import type { DtdMondayClient } from '../monday/client';
import { sentPromptsForGiftDates } from '../db/prompts';
import { recordsForFiscalYear } from '../db/records';
import { MATCHING_GIFT_TYPE } from '../pairing/pair';
import { computePromptSummary, computeSummary, fiscalYearBounds, fiscalYearOf } from '../reporting/summary';

export interface SummaryDeps { monday: DtdMondayClient; db: D1Database; config: DtdSyncConfig }

/** Rewrites the Program Summary rows for the current and previous fiscal year; every run recomputes from scratch. */
export async function runSummary(deps: SummaryDeps, now: Date): Promise<void> {
  const { monday, db, config } = deps;
  const c = config.programSummary;
  const today = now.toISOString().slice(0, 10);
  const matchingDonations = (await monday.listDonationsOfTypeDatedSince(MATCHING_GIFT_TYPE, '2000-01-01')).filter(
    (i) => i.date !== null,
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
    const giftIds = matches.map((m) => m.matchesGiftItemId).filter((id): id is string => id !== null);
    for (const gift of await monday.getDonations(giftIds)) {
      if (gift.amount !== null) giftAmountById.set(gift.id, gift.amount);
    }

    const records = await recordsForFiscalYear(db, startISO, endISO);
    const s = computeSummary(records, matches, giftAmountById, priorCompanies, priorDonors);
    const prompts: Record<string, string> = {};
    if (config.outreach !== null) {
      const o = config.outreach.programSummary;
      const p = computePromptSummary(await sentPromptsForGiftDates(db, startDate, endDate), matchingDonations);
      prompts[o.prompted] = String(p.prompted);
      prompts[o.promptedMatched] = String(p.promptedMatched);
      prompts[o.promptedMatchDollars] = p.promptedMatchDollars.toFixed(2);
    }
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
      ...prompts,
      [c.asOf]: { date: today },
    });
    console.log(JSON.stringify({ job: 'summary', fiscalYear: fy, screened: s.screened, matchesPaid: s.matchesPaid }));
  }
}
