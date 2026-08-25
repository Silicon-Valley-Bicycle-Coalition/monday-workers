import type { MondayClient } from '../monday/client';
import type { DonationRecord, TaxLetterConfig } from '../types';
import { parseAmount as parseAmountOrNull } from '../amounts';

export interface LetterGift {
  date: string;
  amount: string;
}

export interface LetterData {
  donorId: string;
  donorName: string;
  year: number;
  gifts: LetterGift[];
  totalFormatted: string;
  statement: string;
}

export interface LetterYearListing {
  donorId: string;
  donorName: string;
  years: number[];
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

// Thin wrapper over the shared parser: a letter total sums amounts, so unparseable text
// contributes 0 rather than poisoning the sum with null.
export function parseAmount(text: string): number {
  return parseAmountOrNull(text) ?? 0;
}

export function giftYear(date: string): number | null {
  const match = /^(\d{4})-/.exec(date);
  return match ? Number(match[1]) : null;
}

function completedYearsWithGifts(donations: DonationRecord[], now: Date): number[] {
  const currentYear = now.getUTCFullYear();
  const years = new Set<number>();
  for (const donation of donations) {
    const year = giftYear(donation.date);
    if (year !== null && year < currentYear) {
      years.add(year);
    }
  }
  return [...years].sort((a, b) => b - a);
}

export async function listLetterYears(
  donorItemIds: string[],
  monday: MondayClient,
  now: Date
): Promise<LetterYearListing[]> {
  const donors = await Promise.all(donorItemIds.map((id) => monday.getDonorPortalData(id)));
  return donors.map((donor) => ({
    donorId: donor.id,
    donorName: donor.name,
    years: completedYearsWithGifts(donor.donations, now),
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

  const donor = await monday.getDonorPortalData(donorItemId);
  const gifts = donor.donations
    .filter((donation) => giftYear(donation.date) === year)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((donation) => ({ date: donation.date, amount: donation.amount }));

  if (gifts.length === 0) {
    return null;
  }

  const total = donor.donations
    .filter((donation) => giftYear(donation.date) === year)
    .reduce((sum, donation) => sum + parseAmount(donation.amount), 0);

  const statement = taxLetter.benefitTiers.includes(donor.membershipTier)
    ? taxLetter.benefitStatement
    : taxLetter.plainStatement;

  return {
    donorId: donor.id,
    donorName: donor.name,
    year,
    gifts,
    totalFormatted: USD.format(total),
    statement,
  };
}
