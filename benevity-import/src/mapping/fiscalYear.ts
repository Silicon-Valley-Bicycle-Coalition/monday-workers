export function fiscalYearEnding(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`fiscalYear: "${isoDate}" is not a valid date`);
  }
  const month = date.getUTCMonth(); // 0 = January
  const year = date.getUTCFullYear();
  const endingYear = month >= 6 ? year + 1 : year; // Jul(6)-Dec(11) -> next calendar year's June 30
  return `${endingYear}-06-30`;
}
