import type { DtdSyncConfig } from '../config';
import type { DonationItem } from '../monday/client';

/** The Gift Type label benevity-import (and staff) write for an employer matching gift. */
export const MATCHING_GIFT_TYPE = 'Matching Donation';

const MATCH_SUFFIX = '-match';
const COMPANY_SUFFIXES = new Set(['inc', 'llc', 'corp', 'corporation', 'co', 'company']);

export type PairingResult =
  | { kind: 'certain' | 'auto'; giftItemId: string }
  | { kind: 'review'; candidates: string[] };

/** Lowercase, strip punctuation, collapse whitespace, then drop trailing corporate suffixes. */
export function normalizeCompany(name: string): string {
  const tokens = name.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && COMPANY_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join(' ');
}

/** ISO date `months` calendar months before the given ISO date (UTC, day clamped). */
export function monthsBefore(iso: string, months: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

export function pairMatch(
  match: DonationItem, matchCompanyName: string | null, candidates: DonationItem[],
  companyOf: (giftItemId: string) => string | null, cfg: DtdSyncConfig['pairing'],
): PairingResult {
  if (match.date === null) return { kind: 'review', candidates: [] };
  const from = monthsBefore(match.date, cfg.windowMonths);
  const eligible = candidates.filter((c) =>
    c.id !== match.id && c.giftType !== MATCHING_GIFT_TYPE && c.date !== null && c.date >= from && c.date <= match.date!);

  const txn = match.benevityTransactionId;
  if (txn !== null && txn.endsWith(MATCH_SUFFIX)) {
    const original = txn.slice(0, -MATCH_SUFFIX.length);
    const same = eligible.find((c) => c.benevityTransactionId === original);
    if (same) return { kind: 'certain', giftItemId: same.id };
  }

  if (matchCompanyName === null) return { kind: 'review', candidates: [] };
  const wanted = normalizeCompany(matchCompanyName);
  const floor = match.amount === null ? null : match.amount * (1 - cfg.amountTolerance);
  const hits = eligible.filter((c) => {
    const company = companyOf(c.id);
    if (company === null || normalizeCompany(company) !== wanted) return false;
    return floor === null || (c.amount !== null && c.amount >= floor);
  });
  if (hits.length === 1) return { kind: 'auto', giftItemId: hits[0]!.id };
  return { kind: 'review', candidates: hits.map((c) => c.id) };
}
