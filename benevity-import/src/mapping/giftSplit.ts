import type { ParsedRow } from '../parse/report';
import type { BenevityImportConfig } from '../types';
import { fiscalYearEnding } from './fiscalYear';

export interface GiftContext {
  row: ParsedRow;
  disbursementPeriodEnding: string;
  organizationItemId: string;
  // null means no Person was resolved (anonymous or withheld) — never a placeholder for "not yet looked up".
  personItemId: string | null;
}

export interface GiftSpec {
  transactionId: string;
  itemName: string;
  columnValues: Record<string, unknown>;
}

export function splitRowIntoGifts(ctx: GiftContext, config: BenevityImportConfig): GiftSpec[] {
  const { row, disbursementPeriodEnding, organizationItemId, personItemId } = ctx;
  const cols = config.benevityImport.donationsColumns;
  const donorLabel = personItemId ? `${row.donorFirstName} ${row.donorLastName}`.trim() : 'Anonymous';
  const fyEnding = fiscalYearEnding(row.donationDate);

  const baseColumns = (amount: number): Record<string, unknown> => ({
    [cols.amount]: amount,
    [cols.date]: { date: row.donationDate },
    [cols.disbursementDate]: { date: disbursementPeriodEnding },
    [cols.fiscalYearEnding]: { date: fyEnding },
    [cols.status]: { label: 'Received' },
    [cols.anonymousDonor]: { checked: personItemId ? 'false' : 'true' },
    [cols.transactionId]: row.transactionId,
    ...(personItemId ? { [cols.donor]: { item_ids: [Number(personItemId)] } } : {}),
  });

  const gifts: GiftSpec[] = [];

  if (row.totalDonationToBeAcknowledged > 0) {
    gifts.push({
      transactionId: row.transactionId,
      itemName: `${donorLabel} - Donation ${row.donationDate} (Benevity)`,
      columnValues: {
        ...baseColumns(row.totalDonationToBeAcknowledged),
        [cols.giftType]: { label: 'Donation' },
      },
    });
  }

  if (row.matchAmount > 0) {
    gifts.push({
      transactionId: `${row.transactionId}-match`,
      itemName: `${row.company} - Employer Matching ${donorLabel} ${row.donationDate}`,
      columnValues: {
        ...baseColumns(row.matchAmount),
        [cols.giftType]: { label: 'Matching Donation' },
        [cols.matchedBy]: { item_ids: [Number(organizationItemId)] },
      },
    });
  }

  return gifts;
}
