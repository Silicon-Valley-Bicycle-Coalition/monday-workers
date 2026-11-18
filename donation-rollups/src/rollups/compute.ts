// Every amount here is integer cents (issue GL#27) — summing dollar floats wrote values like
// 714.9300000000001 to Monday. Cents become a decimal string only at the column write
// (money.ts formatCents).
export interface DonationRow {
  amountCents: number;
  dateISO: string;
  fiscalYear: number;
  status: string;
}

export interface Rollup {
  lifetimeGivingCents: number;
  giftCount: number;
  firstGiftISO: string | null;
  thisYearCents: number;
  thisYearCount: number;
  lastYearCents: number;
  lastYearCount: number;
  largestGiftCents: number | null;
  smallestGiftCents: number | null;
  averageGiftCents: number | null; // rounded to a whole cent
  lastGiftDate: string | null;
  lastGiftCents: number | null;
}

// The org's fiscal year, from config ("fiscalYear" — SVBC's runs July->June in Pacific time,
// Salesforce's Organization.FiscalYearStartMonth = 7). A fiscal year is named for the calendar
// year it ends in, matching salesforce-import's fiscalYear() and the Fiscal Year Ending column;
// startMonth 1 makes it the calendar year.
import type { FiscalYearConfig } from '../types';

function fiscalYearOf(year: number, month: number, startMonth: number): number {
  return startMonth > 1 && month >= startMonth ? year + 1 : year;
}

// The calendar date `now` falls on in `timeZone`. Intl, not getUTC*: in UTC the fiscal year
// (issue GL#27) rolled over at 5pm Pacific on June 30.
export function localDateParts(now: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
}

export function currentFiscalYear(now: Date, fy: FiscalYearConfig): number {
  const { year, month } = localDateParts(now, fy.timeZone);
  return fiscalYearOf(year, month, fy.startMonth);
}

// Same rule, applied to a plain "YYYY-MM-DD" date (already a local calendar date, so no zone
// conversion) — used when a Donations board has no Fiscal Year Ending column configured, or the
// cell is blank (hand-entered gifts, or gifts stamped into a column config no longer points at),
// so this Worker isn't hard-blocked on that column before it can compute This/Last Year.
export function fiscalYearFromDate(dateISO: string, startMonth: number): number {
  const [y, m] = dateISO.slice(0, 10).split('-').map(Number);
  return fiscalYearOf(y ?? 0, m ?? 0, startMonth);
}

// Only rows whose Status is exactly the configured "Received" label count — this
// excludes "Received (Historical)" (the migrated Closed Won records) by construction,
// the same distinction transform/donations.ts (salesforce-import) draws for exactly
// this reason. See monday-migration docs/07 gotcha #10 and docs/05 SS8.
export function computeRollup(
  donations: DonationRow[], receivedStatusLabel: string, thisFY: number,
): Rollup {
  const received = donations.filter((d) => d.status === receivedStatusLabel);

  let lifetimeGivingCents = 0, thisYearCents = 0, thisYearCount = 0, lastYearCents = 0, lastYearCount = 0;
  let firstGiftISO: string | null = null, lastGiftDate: string | null = null, lastGiftCents: number | null = null;
  let largestGiftCents: number | null = null, smallestGiftCents: number | null = null;

  for (const d of received) {
    const c = d.amountCents;
    lifetimeGivingCents += c;
    if (d.fiscalYear === thisFY) { thisYearCents += c; thisYearCount++; }
    else if (d.fiscalYear === thisFY - 1) { lastYearCents += c; lastYearCount++; }

    if (firstGiftISO === null || d.dateISO < firstGiftISO) firstGiftISO = d.dateISO;
    if (lastGiftDate === null || d.dateISO >= lastGiftDate) { lastGiftDate = d.dateISO; lastGiftCents = c; }

    if (largestGiftCents === null || c > largestGiftCents) largestGiftCents = c;
    if (smallestGiftCents === null || c < smallestGiftCents) smallestGiftCents = c;
  }

  return {
    lifetimeGivingCents, giftCount: received.length, firstGiftISO,
    thisYearCents, thisYearCount, lastYearCents, lastYearCount,
    largestGiftCents, smallestGiftCents,
    averageGiftCents: received.length > 0 ? Math.round(lifetimeGivingCents / received.length) : null,
    lastGiftDate, lastGiftCents,
  };
}
