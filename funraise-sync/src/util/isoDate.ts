// SVBC's books run on Pacific time: Salesforce CloseDates (what salesforce-import migrated) are
// local business dates, and the fiscal year turns over at midnight Pacific on July 1. Dating a
// Funraise gift by its UTC day put anything given after ~5 pm Pacific on June 30 / Dec 31 into
// the next fiscal / calendar year (#25).
const TIME_ZONE = 'America/Los_Angeles';

// en-CA formats as YYYY-MM-DD. Built once per isolate; workerd ships full ICU time-zone data.
const pacificDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Normalizes a Funraise date value to a `YYYY-MM-DD` calendar date in America/Los_Angeles, or
 * null when it isn't one.
 *
 * Funraise's webhook payload carries dates as epoch milliseconds (`donationDate: 1599067880174`
 * in its documented example); an ISO timestamp is accepted too so fixtures and any future
 * string-dated field go through the same path. A bare `YYYY-MM-DD` is already a calendar date and
 * is kept as-is. Monday's date column and the fiscal-year rule both read this one value, so the
 * two columns can never disagree.
 */
export function toISODate(value: unknown): string | null {
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    if (/^\d+$/.test(value)) return toISODate(Number(value));
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return toISODate(Date.parse(value));
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : pacificDate.format(date);
  }
  return null;
}
