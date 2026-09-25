// SVBC's fiscal year runs July–June (Salesforce `Organization.FiscalYearStartMonth = 7`), named
// for the calendar year it ends in: a 2026-08-15 gift is FY 2027, a 2026-06-30 gift is FY 2026.
// Same rule as salesforce-import's `transform/fields.ts` `fiscalYear()` (which stamps the column
// on every migrated gift) and donation-rollups' `fiscalYearFromDate` (which derives it when the
// cell is blank) — reimplemented here because Workers in this repo don't share code.
//
// Reads only the YYYY-MM-DD prefix. The consumer passes the transaction's `donationDate` after
// `toISODate` has normalized Funraise's epoch milliseconds to a Pacific calendar date — the same
// value it writes to the Date column — so the two columns can never disagree. Returns null
// rather than guessing when the value isn't a date-prefixed string, so the caller can leave the
// column blank instead of writing garbage.
export function fiscalYearEnding(dateISO: unknown): string | null {
  if (typeof dateISO !== 'string') return null;
  const match = /^(\d{4})-(\d{2})/.exec(dateISO);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return String(month >= 7 ? year + 1 : year);
}
