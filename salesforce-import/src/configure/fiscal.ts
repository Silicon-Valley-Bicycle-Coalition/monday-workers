import { fiscalYear } from '../transform/fields.js';

// SVBC's fiscal year runs July to June and is named by the calendar year it ends in: a gift on
// 2025-08-01 is FY2026. "Today" is read in California, so a run just after midnight Pacific on
// July 1 lands in the new year even though UTC is still the day before.
const TIME_ZONE = 'America/Los_Angeles';

export type FiscalYearValue = { fiscalYear: 'current' | 'previous' };

export function isFiscalYearValue(v: unknown): v is FiscalYearValue {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const y = (v as { fiscalYear?: unknown }).fiscalYear;
  return y === 'current' || y === 'previous';
}

/** YYYY-MM-DD of `now` as seen in California. */
export function pacificDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The calendar year the fiscal year containing `now` ends in, plus `offset` years. */
export function fiscalYearEnding(now: Date, offset = 0): number {
  return Number(fiscalYear(pacificDate(now))) + offset;
}

export const fiscalYearLabel = (now: Date, offset = 0): string => `FY${fiscalYearEnding(now, offset)}`;

/** First and last day of the fiscal year, as ISO dates, both inclusive. */
export function fiscalYearRange(now: Date, offset = 0): [string, string] {
  const end = fiscalYearEnding(now, offset);
  return [`${end - 1}-07-01`, `${end}-06-30`];
}
