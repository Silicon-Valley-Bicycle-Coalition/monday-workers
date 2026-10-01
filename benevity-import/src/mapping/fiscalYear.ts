// SVBC's fiscal year runs July–June, named for the calendar year it ends in: a 2026-08-15 gift
// is FY 2027, a 2026-06-30 gift is FY 2026. Returns the bare year as a string ("2027", never
// "2027-06-30") — the shape salesforce-import's `transform/fields.ts` `fiscalYear()` and
// funraise-sync's `fiscalYearEnding` write to the same text column, and the only one
// donation-rollups reads back with `Number()`. Reimplemented here because Workers in this repo
// don't share code.
export function fiscalYearEnding(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`fiscalYear: "${isoDate}" is not a valid date`);
  }
  const month = date.getUTCMonth(); // 0 = January
  const year = date.getUTCFullYear();
  return String(month >= 6 ? year + 1 : year); // Jul(6)-Dec(11) -> the fiscal year ending next June
}
