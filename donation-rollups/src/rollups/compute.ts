export interface DonationRow {
  amount: number;
  dateISO: string;
  fiscalYear: number;
  status: string;
}

export interface Rollup {
  lifetimeGiving: number;
  giftCount: number;
  firstGiftISO: string | null;
  thisYearAmount: number;
  thisYearCount: number;
  lastYearAmount: number;
  lastYearCount: number;
  largestGift: number | null;
  smallestGift: number | null;
  averageGift: number | null;
  lastGiftDate: string | null;
  lastGiftAmount: number | null;
}

// SVBC's fiscal year runs July->June (Organization.FiscalYearStartMonth = 7). Same
// integer-parsing approach as salesforce-import's fiscalYear() — no Date-object
// arithmetic needed since only the month/year matter, not a full timestamp.
export function currentFiscalYear(now: Date): number {
  const month = now.getUTCMonth() + 1; // getUTCMonth is 0-indexed
  const year = now.getUTCFullYear();
  return month >= 7 ? year + 1 : year;
}

// Same rule, applied to a plain "YYYY-MM-DD" date rather than "now" — used when a
// Donations board doesn't have its own Fiscal Year column yet (confirmed missing on
// every board in the CRM Sandbox as of 2026-08-24) so this Worker isn't hard-blocked
// on that column existing everywhere before it can compute This/Last Year splits.
export function fiscalYearFromDate(dateISO: string): number {
  const [y, m] = dateISO.slice(0, 10).split('-').map(Number);
  return (m ?? 0) >= 7 ? (y ?? 0) + 1 : (y ?? 0);
}

// Only rows whose Status is exactly the configured "Received" label count — this
// excludes "Received (Historical)" (the migrated Closed Won records) by construction,
// the same distinction transform/donations.ts (salesforce-import) draws for exactly
// this reason. See monday-migration docs/07 gotcha #10 and docs/05 SS8.
export function computeRollup(
  donations: DonationRow[], receivedStatusLabel: string, thisFY: number,
): Rollup {
  const received = donations.filter((d) => d.status === receivedStatusLabel);

  let lifetimeGiving = 0, thisYearAmount = 0, thisYearCount = 0, lastYearAmount = 0, lastYearCount = 0;
  let firstGiftISO: string | null = null, lastGiftDate: string | null = null, lastGiftAmount: number | null = null;
  let largestGift: number | null = null, smallestGift: number | null = null;

  for (const d of received) {
    lifetimeGiving += d.amount;
    if (d.fiscalYear === thisFY) { thisYearAmount += d.amount; thisYearCount++; }
    else if (d.fiscalYear === thisFY - 1) { lastYearAmount += d.amount; lastYearCount++; }

    if (firstGiftISO === null || d.dateISO < firstGiftISO) firstGiftISO = d.dateISO;
    if (lastGiftDate === null || d.dateISO >= lastGiftDate) { lastGiftDate = d.dateISO; lastGiftAmount = d.amount; }

    if (largestGift === null || d.amount > largestGift) largestGift = d.amount;
    if (smallestGift === null || d.amount < smallestGift) smallestGift = d.amount;
  }

  return {
    lifetimeGiving, giftCount: received.length, firstGiftISO,
    thisYearAmount, thisYearCount, lastYearAmount, lastYearCount,
    largestGift, smallestGift,
    averageGift: received.length > 0 ? lifetimeGiving / received.length : null,
    lastGiftDate, lastGiftAmount,
  };
}
