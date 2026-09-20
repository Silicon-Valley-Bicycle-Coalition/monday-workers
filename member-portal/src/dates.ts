// Monday's date columns come back as plain "YYYY-MM-DD" text (no time component) — parsed at
// UTC midnight and formatted in UTC too, so the displayed date never shifts by a day depending
// on the reader's or the Worker's local timezone (same approach as card/loadCardData.ts's
// formatExpiry).
export function formatShortDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
