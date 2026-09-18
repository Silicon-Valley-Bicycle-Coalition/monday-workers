/**
 * Normalizes a Funraise date value to a UTC `YYYY-MM-DD` string, or null when it isn't one.
 *
 * Funraise's webhook payload carries dates as epoch milliseconds (`donationDate: 1599067880174`
 * in its documented example); an ISO timestamp is accepted too so fixtures and any future
 * string-dated field go through the same path. Monday's date column wants `{ date: 'YYYY-MM-DD' }`
 * and the fiscal-year rule wants the same calendar date, so both read from this one value.
 */
export function toISODate(value: unknown): string | null {
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    if (/^\d+$/.test(value)) return toISODate(Number(value));
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  return null;
}
