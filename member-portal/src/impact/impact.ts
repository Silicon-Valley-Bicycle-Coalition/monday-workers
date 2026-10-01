import type { Locale } from '../i18n/locales';
import type { DonationRecord, DonorImpact, ImpactConfig } from '../types';

// The statements for the most recent year that both has statements configured and holds one of
// this donor's gifts — so "your giving in {{year}}" is always true of the person reading it.
// `donations` is the list the Monday client already filtered to countable statuses and the
// history floor; an undated gift can't be placed in a year, so it never qualifies one.
export function selectImpact(donations: DonationRecord[], config: ImpactConfig, locale: Locale): DonorImpact | null {
  // Monday date-column text is YYYY-MM-DD, so the first four characters are the year.
  const giftYears = new Set(donations.map((donation) => donation.date.slice(0, 4)));
  // Four-digit year keys (validated in config.ts) order correctly as strings.
  const year = Object.keys(config.statementsByYear)
    .filter((candidate) => giftYears.has(candidate))
    .sort()
    .pop();
  const byLocale = year === undefined ? undefined : config.statementsByYear[year];
  if (year === undefined || byLocale === undefined) return null;
  return { year, statements: byLocale[locale] ?? byLocale.en };
}
