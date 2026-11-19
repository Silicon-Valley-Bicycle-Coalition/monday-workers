import type { MondayClient } from '../monday/client';
import type { DonationRecord, TaxLetterConfig } from '../types';
import { parseAmount as parseAmountOrNull } from '../amounts';
import { formatUsd } from '../money';
import { giftTypeIn } from './giftTypes';

export interface LetterGift {
  date: string;
  amount: string;
}

export interface LetterData {
  donorId: string;
  donorName: string;
  year: number;
  // The acknowledged contributions: these make up the total and sit under the statement.
  gifts: LetterGift[];
  // Listed for the donor's records under taxLetter.separateGiftsStatement instead, outside the total.
  separateGifts: LetterGift[];
  totalFormatted: string;
  statement: string;
}

export interface LetterYearListing {
  donorId: string;
  donorName: string;
  years: number[];
}

// Thin wrapper over the shared parser: a letter total sums amounts, so unparseable text
// contributes 0 rather than poisoning the sum with null.
export function parseAmount(text: string): number {
  return parseAmountOrNull(text) ?? 0;
}

export function giftYear(date: string): number | null {
  const match = /^(\d{4})-/.exec(date);
  return match ? Number(match[1]) : null;
}

// A DonationRecord's description is the board's Gift Type column (monday.columns.donationDescription
// holds its id). The filter lives here rather than in the client because the portal's giving
// history still shows every gift; only the letter treats them differently.
function onLetter(donation: { description: string }, taxLetter: TaxLetterConfig): boolean {
  return !giftTypeIn(taxLetter.excludedGiftTypes, donation.description);
}

// The one rule for what a letter or statement acknowledges: drop the excluded Gift Types, then
// split off the types listed separately. `description` is the Gift Type text. Input order is kept
// (callers sort), so this stays a pure partition.
export function splitForLetter<T extends { description: string }>(
  gifts: T[],
  taxLetter: TaxLetterConfig
): { acknowledged: T[]; separate: T[] } {
  const onThisLetter = gifts.filter((gift) => onLetter(gift, taxLetter));
  const isSeparate = (gift: T) => giftTypeIn(taxLetter.separateGiftTypes, gift.description);
  return { acknowledged: onThisLetter.filter((g) => !isSeparate(g)), separate: onThisLetter.filter(isSeparate) };
}

function completedYearsWithGifts(donations: DonationRecord[], taxLetter: TaxLetterConfig, now: Date): number[] {
  const currentYear = now.getUTCFullYear();
  const years = new Set<number>();
  for (const donation of donations) {
    const year = giftYear(donation.date);
    if (year !== null && year < currentYear && onLetter(donation, taxLetter)) {
      years.add(year);
    }
  }
  return [...years].sort((a, b) => b - a);
}

export async function listLetterYears(
  donorItemIds: string[],
  monday: MondayClient,
  taxLetter: TaxLetterConfig,
  now: Date
): Promise<LetterYearListing[]> {
  const donors = await Promise.all(donorItemIds.map((id) => monday.getMemberPortalData(id)));
  return donors.map((donor) => ({
    donorId: donor.id,
    donorName: donor.name,
    years: completedYearsWithGifts(donor.donations, taxLetter, now),
  }));
}

export async function loadLetterData(
  donorItemId: string,
  year: number,
  monday: MondayClient,
  taxLetter: TaxLetterConfig,
  now: Date
): Promise<LetterData | null> {
  if (year >= now.getUTCFullYear()) {
    return null;
  }

  const donor = await monday.getMemberPortalData(donorItemId);
  const { acknowledged, separate } = splitForLetter(
    donor.donations.filter((donation) => giftYear(donation.date) === year).sort((a, b) => a.date.localeCompare(b.date)),
    taxLetter
  );

  if (acknowledged.length + separate.length === 0) {
    return null;
  }

  const toLetterGift = (donation: DonationRecord) => ({ date: donation.date, amount: donation.amount });
  const total = acknowledged.reduce((sum, donation) => sum + parseAmount(donation.amount), 0);

  const statement = taxLetter.benefitTiers.includes(donor.membershipTier)
    ? taxLetter.benefitStatement
    : taxLetter.plainStatement;

  return {
    donorId: donor.id,
    donorName: donor.name,
    year,
    gifts: acknowledged.map(toLetterGift),
    separateGifts: separate.map(toLetterGift),
    totalFormatted: formatUsd(total),
    statement,
  };
}
