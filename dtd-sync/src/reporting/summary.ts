import type { StoredRecord } from '../db/records';
import type { DonationItem } from '../monday/client';

/** One number per Program Summary metric column (not Fiscal Year / As of). */
export interface ProgramSummary {
  screened: number; employerIdentified: number; eligible: number; submitted: number; matchesPaid: number;
  matchDollars: number; matchedGiftDollars: number; newMatchingCompanies: number; firstTimeMatchedDonors: number;
}

const NOT_ELIGIBLE = new Set([':ineligible', ':closed-program-eligibility', ':closed-no-matching-gift-program', ':unknown-employer']);
const EMPLOYER_IDENTIFIED = ':complete';
const WAITING_FOR_VERIFICATION = ':waiting-for-verification';

/** Fiscal year runs July–June and is named by its end year: 2026-07-01 is FY2027. Takes a date or ISO datetime (UTC). */
export function fiscalYearOf(dateISO: string): string {
  const year = Number(dateISO.slice(0, 4));
  const month = Number(dateISO.slice(5, 7));
  return `FY${month >= 7 ? year + 1 : year}`;
}

/** [July 1 00:00 UTC, next July 1 00:00 UTC) as ISO strings. */
export function fiscalYearBounds(fy: string): { startISO: string; endISO: string } {
  const end = Number(fy.slice(2));
  return { startISO: `${end - 1}-07-01T00:00:00.000Z`, endISO: `${end}-07-01T00:00:00.000Z` };
}

const cents = (n: number): number => Math.round(n * 100) / 100;
const distinct = (ids: (string | null)[], prior: Set<string>): number =>
  new Set(ids.filter((id): id is string => id !== null && !prior.has(id))).size;

/**
 * `matches` are the fiscal year's Matching Donation items; `giftAmountById` holds the amounts of the gifts
 * they are paired to (`matchesGiftItemId`); the prior sets come from Matching Donations before the year.
 */
export function computeSummary(
  records: StoredRecord[], matches: DonationItem[], giftAmountById: Map<string, number>,
  priorMatchCompanyIds: Set<string>, priorMatchedDonorIds: Set<string>,
): ProgramSummary {
  const pairedGiftIds = new Set(matches.map((m) => m.matchesGiftItemId).filter((id): id is string => id !== null));
  const identified = records.filter((r) => r.employerStatus === EMPLOYER_IDENTIFIED);
  return {
    screened: records.length,
    employerIdentified: identified.length,
    // Same keyword rule as pull's Match Status: matching_gift_status when DTD sent one, else status.
    eligible: identified.filter((r) => {
      const keyword = r.matchingGiftStatus ?? r.status;
      return keyword === null || !NOT_ELIGIBLE.has(keyword);
    }).length,
    submitted: records.filter(
      (r) => r.matchingGiftStatus === WAITING_FOR_VERIFICATION || (r.mondayItemId !== null && pairedGiftIds.has(r.mondayItemId)),
    ).length,
    matchesPaid: matches.length,
    matchDollars: cents(matches.reduce((t, m) => t + (m.amount ?? 0), 0)),
    matchedGiftDollars: cents([...pairedGiftIds].reduce((t, id) => t + (giftAmountById.get(id) ?? 0), 0)),
    newMatchingCompanies: distinct(matches.map((m) => m.matchedByItemId), priorMatchCompanyIds),
    firstTimeMatchedDonors: distinct(matches.map((m) => m.donorItemId), priorMatchedDonorIds),
  };
}

/** One number per outreach.programSummary column. */
export interface PromptSummary { prompted: number; promptedMatched: number; promptedMatchDollars: number }

/** `promptedGiftIds` are one fiscal year's emailed gifts; `allMatches` any year's, since a match can land in the next one. */
export function computePromptSummary(promptedGiftIds: string[], allMatches: DonationItem[]): PromptSummary {
  const prompted = new Set(promptedGiftIds);
  const matches = allMatches.filter((m) => m.matchesGiftItemId !== null && prompted.has(m.matchesGiftItemId));
  return {
    prompted: prompted.size,
    promptedMatched: new Set(matches.map((m) => m.matchesGiftItemId)).size,
    promptedMatchDollars: cents(matches.reduce((t, m) => t + (m.amount ?? 0), 0)),
  };
}
