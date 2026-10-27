import type { Schedule } from './config';

// Wall-clock parts of an instant in the configured zone. The cron fires on the hour in UTC and
// Pacific offsets are whole hours, so the local hour is exact.
export interface LocalTime { date: string; year: number; month: number; day: number; weekday: number; hour: number }

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localTime(now: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  const [year, month, day] = [Number(part('year')), Number(part('month')), Number(part('day'))];
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    year, month, day,
    weekday: WEEKDAYS.indexOf(part('weekday')),
    hour: Number(part('hour')),
  };
}

export function isDue(schedule: Schedule, t: LocalTime): boolean {
  if (schedule.hour !== t.hour) return false;
  if (schedule.weekdays) return schedule.weekdays.includes(t.weekday);
  return schedule.monthDays!.includes(t.day);
}

// Calendar arithmetic on YYYY-MM-DD strings, in UTC so no zone or DST shift can move a day.
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

// The first day of this month through the last day of next month.
export function thisAndNextMonth(t: LocalTime): { from: string; to: string } {
  return { from: iso(t.year, t.month, 1), to: iso(t.year, t.month + 2, 0) };
}

// SVBC's July–June fiscal year, named by the year it ends in (2026-10-26 is FY2027).
export function fiscalYear(t: LocalTime): { label: string; start: string } {
  const endYear = t.month >= 7 ? t.year + 1 : t.year;
  return { label: `FY${endYear}`, start: iso(endYear - 1, 7, 1) };
}
