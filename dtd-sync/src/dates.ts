export const TIME_ZONE = 'America/Los_Angeles';

/** Today's date (YYYY-MM-DD) in Los Angeles. */
export function todayLosAngeles(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** `date` (YYYY-MM-DD) minus whole calendar days. */
export function daysBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}
